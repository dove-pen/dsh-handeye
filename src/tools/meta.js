// Meta tools: episode lifecycle, history queries, re-planning and pausing.
//
// These are the only tools allowed to run while PAUSED or REPLAN_REQUIRED,
// because they are how the model gets back into a legal state.

import { beginEpisode, pause, satisfyReplan, checkpoint } from '../core/state.js'
import { formatChecks } from '../core/verify.js'
import { newEpisodeId } from '../memory/episodes.js'

const TEXT_OUTPUT = 'text'

function text(value) {
  return String(value ?? '')
}

export function createMetaTools({ state, episodes, onBegin, verifyStep }) {
  return [
    {
      name: 'episode_begin',
      description:
        'Declare the start of one task episode. Call this once before a multi-step task so actions, timing and outcomes are recorded together. The intent is free text (the user goal). Pass cardId when you are running a built-in task card, so its acceptance rules apply to episode_checkpoint.',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'The user goal this episode is serving.' },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional whitelist of tool patterns (for example "browser_*"). Empty means all tools.',
          },
          cardId: {
            type: 'string',
            description: 'Optional task-card id. Turns on that card\'s acceptance checks for this episode.',
          },
          params: {
            type: 'object',
            description:
              'Values for the card parameters (used by the acceptance checks, e.g. {{path}}). Pass the same values you were given.',
          },
        },
        required: ['intent'],
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const intent = text(args?.intent).trim()
        if (!intent) return 'episode_begin requires a non-empty intent'
        const id = newEpisodeId(new Date())
        const cardId = text(args?.cardId).trim()
        const params = args?.params && typeof args.params === 'object' ? args.params : {}
        beginEpisode(state, intent, { episodeId: id, allowedTools: args?.allowedTools, cardId, params })
        // 必须等它把卡片的验收/步骤挂完，否则紧接着的 checkpoint 会因为还没挂上而静默跳过验收
        if (typeof onBegin === 'function') await onBegin({ id, intent, cardId })
        return cardId
          ? `Episode ${id} started: ${intent}（已挂上卡片 ${cardId} 的验收）`
          : `Episode ${id} started: ${intent}`
      },
    },
    {
      name: 'episode_query',
      description:
        'Read recorded episodes. action="list" returns recent episodes (id, start time, outcome, intent); action="show" returns one episode as JSON, including its steps.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show'], description: 'List recent episodes or show one.' },
          id: { type: 'string', description: 'Episode id for action="show".' },
          limit: { type: 'number', description: 'For list: maximum episodes (default 20).' },
          since: { type: 'string', description: 'For list: ISO lower bound.' },
        },
        required: ['action'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const action = text(args?.action).trim()
        if (action === 'show') {
          if (!args?.id) return 'episode_query show requires an id'
          const result = await episodes.read(args.id)
          if (!result.ok) return `episode_query failed: ${result.message}`
          return JSON.stringify(result.value, null, 2)
        }
        const result = await episodes.list({
          limit: Number.isFinite(args?.limit) ? args.limit : 20,
          since: args?.since,
        })
        if (!result.ok) return `episode_query failed: ${result.message}`
        if (result.value.length === 0) return 'No episodes recorded yet.'
        return result.value
          .map((e) => `${e.id}  ${e.startedAt ?? ''}  ${e.outcome ?? ''}  ${e.intent?.text ?? e.intent ?? ''}`)
          .join('\n')
      },
    },
    {
      name: 'episode_replan',
      description:
        'Restate the plan before continuing. Required after the user sends a constraint or resumes a paused run. Actions are refused until this is called with a non-trivial plan.',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'Concrete next steps; at least 12 characters.' },
        },
        required: ['plan'],
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const plan = text(args?.plan).trim()
        satisfyReplan(state, plan)
        if (state.needsReplan) {
          return 'Plan too short. Restate the next steps in at least 12 characters.'
        }
        if (state.state !== 'RUNNING') {
          return `Re-plan accepted, but the runtime is ${state.state}; resume it first.`
        }
        return 'Plan accepted. Actions are allowed again; you must follow this plan.'
      },
    },
    {
      name: 'episode_checkpoint',
      description:
        'Record that the current step of the declared task path is done, and unlock the next step. If the episode carries acceptance checks (a task card with "verify"), they run first: when they fail the step is NOT advanced and you get the exact expected-vs-actual for each check. Fix what failed, then call this again.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What was actually done in this step.' },
        },
        required: ['summary'],
      },
      timeoutMs: 130000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const summary = text(args?.summary).trim()
        if (!summary) return 'episode_checkpoint needs a short summary of what was done'

        // 验收门：有判据就必须先过。没有判据的 episode 保持老行为。
        let verdict = null
        if (typeof verifyStep === 'function') {
          try {
            verdict = await verifyStep(state, { summary })
          } catch (error) {
            verdict = {
              ok: false,
              checks: [
                {
                  type: 'verify',
                  target: '验收引擎',
                  expected: '能跑完',
                  actual: `抛错：${error instanceof Error ? error.message : String(error)}`,
                  ok: false,
                },
              ],
            }
          }
          if (verdict && verdict.ok === false) {
            state.verifyFailures = Number(state.verifyFailures || 0) + 1
            const hint =
              state.verifyFailures >= 2
                ? '\n（这是第 ' +
                  state.verifyFailures +
                  ' 次没过。别再自己换办法硬刚：说明你打算怎么改，或者停下等我决定。）'
                : ''
            return [
              '失败：这一步的验收没过，路径没有推进。',
              formatChecks(verdict),
              '把上面"实际"那一栏对应的东西做出来，再调一次 episode_checkpoint。',
            ].join('\n') + hint
          }
        }

        const result = checkpoint(state, summary)
        if (!result.ok) return `episode_checkpoint: ${result.message}`
        state.verifyFailures = 0
        const note = verdict && verdict.overridden ? '\n（本次是人工放行，验收没有跑）' : ''
        return (result.done
          ? `Path complete (${result.index} steps).`
          : `Step ${result.index} done. Next: ${result.next}`) + note
      },
    },
    {
      name: 'pause_request',
      description:
        'Pause the runtime when you are uncertain or about to do something risky. Only the user can resume, and resuming requires a new plan.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the run should pause.' },
        },
        required: ['reason'],
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const reason = text(args?.reason).trim() || 'Paused by the model'
        pause(state, reason)
        return `Paused: ${state.reason}. Waiting for the user to resume.`
      },
    },
  ]
}

export { TEXT_OUTPUT }
