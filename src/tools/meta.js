// Meta tools: episode lifecycle, history queries, re-planning and pausing.
//
// These are the only tools allowed to run while PAUSED or REPLAN_REQUIRED,
// because they are how the model gets back into a legal state.

import { beginEpisode, pause, satisfyReplan } from '../core/state.js'
import { newEpisodeId } from '../memory/episodes.js'

const TEXT_OUTPUT = 'text'

function text(value) {
  return String(value ?? '')
}

export function createMetaTools({ state, episodes, onBegin }) {
  return [
    {
      name: 'episode_begin',
      description:
        'Declare the start of one task episode. Call this once before a multi-step task so actions, timing and outcomes are recorded together. The intent is free text (the user goal).',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'The user goal this episode is serving.' },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional whitelist of tool patterns (for example "browser_*"). Empty means all tools.',
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
        beginEpisode(state, intent, { episodeId: id, allowedTools: args?.allowedTools })
        if (typeof onBegin === 'function') onBegin({ id, intent })
        return `Episode ${id} started: ${intent}`
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
