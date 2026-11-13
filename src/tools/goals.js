// Goal tools: the user-visible "长期目标 / 分项步骤" layer.
//
// These are thin wrappers over the goal store plus the runtime state machine.
// The interesting part is not the storage - it is that entering a step is a
// *state transition*: from then on the gate only allows the tools that step
// allows, and episode_checkpoint has to satisfy that step's acceptance rules.

import { summarizeGoal, validateGoal, DEFAULT_STEP_BUDGET } from '../memory/goals.js'
import { formatChecks } from '../core/verify.js'

function text(value) {
  return String(value ?? '')
}

function progressLine(summary) {
  const bits = [`${summary.done}/${summary.total} steps`]
  if (summary.doing) bits.push(`doing ${summary.doing}`)
  if (summary.blocked) bits.push(`blocked ${summary.blocked}`)
  else if (summary.next) bits.push(`next ${summary.next}`)
  return bits.join(' · ')
}

function stepLine(step) {
  const mark = { todo: '○', doing: '▸', done: '✓', blocked: '×', skipped: '-' }[step.status] || '?'
  const prompt = step.promptId ? ` [${step.promptId}]` : ''
  return `${mark} ${step.id} ${step.title}${prompt}`
}

export function createGoalTools({ state, goals, skills, cards, verifyStep, prepareStepChecks, onStepEnter, onStepLeave }) {
  const fail = (message) => `Failed: ${message}`

  async function goalOf(id) {
    const got = await goals.get(id)
    return got.ok ? got.value : null
  }

  return [
    {
      name: 'goal_create',
      description:
        'Create a long-running goal: one sentence the user actually said, plus optional first-cut steps. Later steps are edited with goal_plan. Returns the goal id you must pass to the other goal_* tools.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name for this goal (used in the UI).' },
          longTermGoal: { type: 'string', description: 'What the user is actually trying to achieve, ideally their own words.' },
          steps: {
            type: 'array',
            description: 'Optional first cut of the steps (plain strings, or objects with title/promptId).',
            items: { type: 'object', properties: { title: { type: 'string' }, promptId: { type: 'string' } }, required: ['title'] },
          },
        },
        required: ['title', 'longTermGoal'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const created = await goals.create({
          title: text(args?.title).trim(),
          longTermGoal: text(args?.longTermGoal).trim(),
          steps: Array.isArray(args?.steps) ? args.steps : [],
        })
        if (!created.ok) return fail(`Could not create goal: ${created.message}${created.errors ? ' ' + JSON.stringify(created.errors.slice(0, 3)) : ''}`)
        const doc = created.value
        // 建目标即"采用"：从这一刻起，写操作必须先 goal_step_enter，否则步骤门会拒。
        state.goalId = doc.id
        const lines = [`Goal ${doc.id} created: ${doc.title}`, `Long-term goal: ${doc.longTermGoal}`]
        if (doc.steps.length > 0) {
          lines.push(`Steps (${doc.steps.length}):`)
          for (const step of doc.steps) lines.push(`  ${stepLine(step)}`)
          lines.push('Next: use goal_step_enter to start a step.')
        } else {
          lines.push('No steps yet: use goal_plan to write 3-7 steps.')
        }
        return lines.join('\n')
      },
    },

    {
      name: 'goal_plan',
      description:
        'Write or replace the step list of a goal. Each step is a short title the user can understand, optionally bound to a task card (promptId) and/or carrying its own acceptance rules (verify). Step ids are positional: s1, s2, ...',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id from goal_create.' },
          steps: {
            type: 'array',
            description: 'Ordered steps.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                promptId: { type: 'string' },
                verify: { type: 'array', description: 'Optional acceptance rules for this step.' },
                budget: { type: 'object', properties: { actions: { type: 'number' } } },
              },
              required: ['title'],
            },
          },
        },
        required: ['goalId', 'steps'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const id = text(args?.goalId).trim()
        if (!id) return fail('goal_plan needs goalId')
        const steps = Array.isArray(args?.steps) ? args.steps : []
        if (steps.length === 0) return fail('At least one step is required')
        const saved = await goals.setPlan(id, steps)
        if (!saved.ok) return fail(`Could not write steps: ${saved.message}${saved.errors ? ' ' + JSON.stringify(saved.errors.slice(0, 3)) : ''}`)
        const doc = saved.value
        state.goalId = doc.id
        const lines = [`Steps of goal ${doc.id} updated (${doc.steps.length} steps):`]
        for (const step of doc.steps) lines.push(`  ${stepLine(step)}`)
        return lines.join('\n')
      },
    },

    {
      name: 'goal_status',
      description:
        'Read goal progress. With no goalId: list every goal that is not archived. With a goalId: full detail for that goal, including each step status and its acceptance rules.',
      parameters: {
        type: 'object',
        properties: { goalId: { type: 'string', description: 'Optional: show one goal in detail.' } },
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const id = text(args?.goalId).trim()
        if (!id) {
          const listed = await goals.list()
          if (!listed.ok) return fail(listed.message)
          const active = listed.value.filter((g) => g.status !== 'archived')
          if (active.length === 0) return 'No goals yet. Use goal_create to make one.'
          return active
            .map((g) => {
              const s = summarizeGoal(g)
              return `${g.status === 'active' ? '●' : '○'} ${g.id}  ${g.title}  ${progressLine(s)}`
            })
            .join('\n')
        }
        const doc = await goalOf(id)
        if (!doc) return fail(`Goal not found: ${id}`)
        const s = summarizeGoal(doc)
        const lines = [
          `Goal ${doc.id} (${doc.status}): ${doc.title}`,
          `Long-term goal: ${doc.longTermGoal}`,
          `Progress: ${progressLine(s)}`,
          'Steps:',
        ]
        for (const step of doc.steps) {
          lines.push(`  ${stepLine(step)}  attempts=${step.attempts ?? 0} verifyFailures=${step.verifyFailures ?? 0}`)
          if (step.verify && step.verify.length) lines.push(`      checks: ${JSON.stringify(step.verify)}`)
          if (step.status === 'blocked' && step.blocks?.length) lines.push(`      blocked: ${step.blocks[step.blocks.length - 1].reason}`)
        }
        const runs = (doc.runs ?? []).slice(-5)
        if (runs.length) {
          lines.push('Recent runs:')
          for (const run of runs) lines.push(`  ${run.at}  ${run.stepId}  ${run.verify ?? '-'}  ${run.episodeId ?? ''}`)
        }
        return lines.join('\n')
      },
    },

    {
      name: 'goal_step_enter',
      description:
        'Start one step of a goal. This is a state transition: until the step is finished or blocked, actions outside this step are refused, and each step allows only a limited number of actions before you must call goal_step_continue. One step at a time.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          stepId: { type: 'string', description: 'Step id such as s1.' },
          promptId: { type: 'string', description: 'Optional: bind a task card to this step.' },
          params: {
            type: 'object',
            description: 'Values for the step acceptance rules (e.g. {{path}}). Pass what the user gave you.',
          },
        },
        required: ['goalId', 'stepId'],
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const goalId = text(args?.goalId).trim()
        const stepId = text(args?.stepId).trim()
        if (!goalId || !stepId) return fail('goal_step_enter needs goalId and stepId')

        // 被卡住的步骤不能"静悄悄重进"：那等于把 blocked 变成无限重试
        const before = await goals.get(goalId)
        const target = before.ok ? before.value.steps.find((s) => s.id === stepId) : null
        const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
        if (target && target.status === 'blocked' && !reason) {
          return fail(`${stepId} is blocked. To re-enter, pass a reason (how you will fix it); otherwise ask a human: goal_skip_step or approve it in the panel.`)
        }

        const entered = await goals.enterStep(goalId, stepId, {
          promptId: typeof args?.promptId === 'string' ? args.promptId.trim() : undefined,
        })
        if (!entered.ok) return fail(`Could not enter the step: ${entered.message}`)

        const { goal, step } = entered.value
        let info = null
        if (typeof onStepEnter === 'function') {
          info = await onStepEnter({ goal, step, params: args?.params && typeof args.params === 'object' ? args.params : {} })
        }
        const budget = step.budget?.actions ?? DEFAULT_STEP_BUDGET
        const lines = [
          `Entered ${goal.title} / ${step.id}: ${step.title}`,
          `Budget: ${budget} actions (going over is blocked; use goal_step_continue)`,
        ]
        if (info?.episodeId) lines.push(`episode=${info.episodeId}`)
        if (info?.checks) lines.push(`checks: ${info.checks} (the step will not advance if they fail)`)
        lines.push('When done, call goal_step_done; do not just claim completion.')
        return lines.join('\n')
      },
    },

    {
      name: 'goal_step_done',
      description:
        'Finish the current step. Runs that step\'s acceptance rules first: if they fail the step is NOT finished, you get the exact expected-vs-actual per check, and the second failure blocks the step and stops you.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          stepId: { type: 'string', description: 'Step id.' },
          summary: { type: 'string', description: 'What was actually done in this step.' },
        },
        required: ['goalId', 'stepId', 'summary'],
      },
      timeoutMs: 130000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const goalId = text(args?.goalId).trim()
        const stepId = text(args?.stepId).trim()
        const summary = text(args?.summary).trim()
        if (!goalId || !stepId) return fail('goal_step_done needs goalId and stepId')
        if (!summary) return fail('goal_step_done needs a summary describing what was actually done')

        const doc = await goalOf(goalId)
        if (!doc) return fail(`Goal not found: ${goalId}`)
        const step = doc.steps.find((s) => s.id === stepId)

        // 只能给正在跑的那一步结账：否则可以在做 s1 的时候把 s3 标成完成，
        // 验收用的却是 s1 的判据。
        if (!state.currentStep || state.currentStep.stepId !== stepId) {
          const running = state.currentStep ? state.currentStep.stepId : '(no step is running)'
          return fail(`This step is not running (current: ${running}); cannot close ${stepId}. Run goal_step_enter ${goalId} ${stepId} first.`)
        }
        if (!step) return fail(`Goal has no step ${stepId}`)
        if (step.status !== 'doing') return fail(`Step ${stepId} is ${step.status}, not doing`)

        let verdict = null
        if (typeof verifyStep === 'function') {
          // 结账前重挂判据：重启后 state 是空的，不重挂就等于"没验就算过"
          if (typeof prepareStepChecks === 'function') await prepareStepChecks({ goal: doc, step })
          verdict = await verifyStep(state)
        }
        if (verdict && verdict.ok === false) {
          const recorded = await goals.recordVerifyFailure(goalId, stepId, firstFailure(verdict))
          // 失败也要留记录，否则 passRate 只有分子没有分母
          await goals.appendRun(goalId, {
            stepId,
            promptId: step.promptId ?? null,
            episodeId: state.episodeId || null,
            verify: 'fail',
            summary: String(summary).slice(0, 200),
            detail: firstFailure(verdict),
          })
          const blocked = Boolean(recorded.ok && recorded.value?.blocked)
          // 技能来源挂在目标上（goal.meta），不在步骤上
          const blockedTutorialId = doc.meta && doc.meta.tutorialId
          if (blocked && blockedTutorialId && cards && typeof cards.recordRun === 'function') {
            await cards.recordRun(blockedTutorialId, { outcome: 'failure', reason: firstFailure(verdict) }).catch(() => {})
          }
          const blockedSkillId = doc.meta && doc.meta.skillId
          if (blocked && blockedSkillId && skills && typeof skills.recordRun === 'function') {
            await skills.recordRun(blockedSkillId, { outcome: 'failure', reason: firstFailure(verdict) }).catch(() => {})
          }
          // 只有真被 blocked 才离开这一步；只挂一次的话步骤还是 doing，
          // 否则模型会丢掉步骤绑定，接着动手就会被步骤门拒得莫名其妙。
          if (blocked && typeof onStepLeave === 'function') {
            await onStepLeave({ goalId, stepId, reason: 'verify-failed' })
          }
          const lines = [
            'Failed: the step checks did not pass; the step is not complete.',
            formatChecks(verdict),
            'Make the "actual" column match the expectation, then call goal_step_done again.',
          ]
          if (blocked) {
            lines.push('')
            lines.push(`Second failure: step ${stepId} is now blocked and actions are locked.`)
            lines.push('A human must decide now: goal_skip_step, change the prompt, or approve manually. Do not try random workarounds.')
          }
          return lines.join('\n')
        }

        const finished = await goals.finishStep(goalId, stepId, { result: 'ok', evidence: evidenceOf(verdict) })
        if (!finished.ok) return fail(`Could not finish the step: ${finished.message}`)
        await goals.appendRun(goalId, {
          stepId,
          promptId: step.promptId ?? null,
          episodeId: state.episodeId || null,
          // 只有真的跑过判据才算"验收通过"；没判据的步骤记 none，
          // 否则通过率会被没有验收的步骤稀释成假的 100%。
          verify: verdict?.overridden
            ? 'override'
            : verdict && Array.isArray(verdict.checks) && verdict.checks.length > 0
              ? 'pass'
              : 'none',
          summary,
        })
        if (typeof onStepLeave === 'function') await onStepLeave({ goalId, stepId, reason: 'done' })

        const after = finished.value.goal
        const summaryLine = summarizeGoal(after)
        const lines = [`✓ done ${stepId}: ${step.title}`]
        if (verdict?.overridden) lines.push('(human override: verification was skipped)')
        lines.push(`Progress: ${progressLine(summaryLine)}`)
        const next = after.steps.find((s) => s.status === 'todo')
        if (next) {
          lines.push(`Next: goal_step_enter ${goalId} ${next.id}`)
        } else {
          // 全部做完必须放开目标焦点：否则 state.goalId 一直挂着，
          // 接下来任何写操作都会被 GOAL_STEP_REQUIRED 拒掉，模型会原地打转。
          if (state.goalId === goalId) state.goalId = ''
          // 由技能编译来的目标：跑完 = 技能成功一次
          const tutorialId = after.meta && after.meta.tutorialId
          if (tutorialId && cards && typeof cards.recordRun === 'function') {
            await cards.recordRun(tutorialId, { outcome: 'success' }).catch(() => {})
            lines.push(`Tutorial health +1: ${tutorialId}`)
          }
          const skillId = after.meta && after.meta.skillId
          if (skillId && skills && typeof skills.recordRun === 'function') {
            await skills.recordRun(skillId, { outcome: 'success' }).catch(() => {})
            lines.push(`Skill health +1: ${skillId}`)
          }
          lines.push('All steps are done; step mode exited (archive with goal_set_status ' + goalId + ' done).')
        }
        return lines.join('\n')
      },
    },

    {
      name: 'goal_step_continue',
      description:
        'Extend the action budget of the current step after the gate refused you for running out. Use it when the step is legitimately bigger than its budget, and say why - every use is recorded and visible to the user.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          stepId: { type: 'string', description: 'Step id.' },
          extra: { type: 'number', description: 'Extra actions to grant (default 8, max 40).' },
          reason: { type: 'string', description: 'Why this step needs more actions.' },
        },
        required: ['goalId', 'stepId', 'reason'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const goalId = text(args?.goalId).trim()
        const stepId = text(args?.stepId).trim()
        const reason = text(args?.reason).trim()
        if (!goalId || !stepId) return fail('goal_step_continue needs goalId and stepId')
        if (reason.length < 4) return fail('Explain why you need more budget (at least 4 chars); this is recorded')
        // 只能续"正在跑的那一步"：以前会把额度加到别的步骤上，两侧永久错位
        if (!state.currentStep || state.currentStep.stepId !== stepId) {
          const running = state.currentStep ? state.currentStep.stepId : '(no step is running)'
          return fail(`This step is not running (current: ${running}); cannot extend ${stepId}.`)
        }
        const extra = Math.min(40, Math.max(1, Number.isInteger(args?.extra) ? args.extra : DEFAULT_STEP_BUDGET))

        const doc = await goalOf(goalId)
        if (!doc) return fail(`Goal not found: ${goalId}`)
        const step = doc.steps.find((s) => s.id === stepId)
        if (!step) return fail(`Goal has no step ${stepId}`)
        if (step.status !== 'doing') return fail(`Step ${stepId} is ${step.status}, not doing`)

        const rolled = await goals.save({
          ...doc,
          steps: doc.steps.map((s) =>
            s.id === stepId ? { ...s, budget: { actions: Number(s.budget?.actions ?? DEFAULT_STEP_BUDGET) + extra } } : s,
          ),
        })
        if (!rolled.ok) return fail(`Could not extend the budget: ${rolled.message}`)
        if (typeof state.grantStepBudget === 'function') state.grantStepBudget(extra)
        await goals.appendRun(goalId, { stepId, kind: 'budget-extend', extra, reason })
        return `Added ${extra} actions to ${stepId} (reason: ${reason}). The user can see this record.`
      },
    },

    {
      name: 'goal_set_status',
      description:
        'Pause, resume, finish or archive a goal. Pausing is also the way to step OUT of a goal: while a goal is active, actions must belong to one of its steps.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'], description: 'New status.' },
        },
        required: ['goalId', 'status'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const goalId = text(args?.goalId).trim()
        const status = text(args?.status).trim()
        if (!goalId) return fail('goal_set_status needs goalId')
        const saved = await goals.setStatus(goalId, status)
        if (!saved.ok) return fail(`Could not update status: ${saved.message}`)
        if (status !== 'active' && typeof onStepLeave === 'function') {
          await onStepLeave({ goalId, stepId: state.currentStep?.stepId ?? null, reason: status })
        }
        if (status !== 'active' && state.goalId === goalId) state.goalId = ''
        const summary = summarizeGoal(saved.value)
        return `Goal ${goalId} is now ${status} (${summary.done}/${summary.total} steps).`
      },
    },
    {
      name: 'goal_skip_step',
      description:
        'Mark a step as skipped and move on. This is a judgement call that a human should usually make: it is recorded with the reason and shows up in goal_status.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          stepId: { type: 'string', description: 'Step id.' },
          reason: { type: 'string', description: 'Why this step is being skipped.' },
        },
        required: ['goalId', 'stepId', 'reason'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const goalId = text(args?.goalId).trim()
        const stepId = text(args?.stepId).trim()
        const reason = text(args?.reason).trim()
        if (!goalId || !stepId) return fail('goal_skip_step needs goalId and stepId')
        if (reason.length < 4) return fail('Skipping requires a reason (at least 4 chars); this is recorded')
        const skipped = await goals.skipStep(goalId, stepId, reason)
        if (!skipped.ok) return fail(`Could not skip: ${skipped.message}`)
        if (typeof onStepLeave === 'function') await onStepLeave({ goalId, stepId, reason: 'skipped' })
        const summary = summarizeGoal(skipped.value.goal)
        return `Skipped ${stepId} (${reason}). Progress: ${progressLine(summary)}`
      },
    },
  ]
}

function firstFailure(verdict) {
  const bad = (verdict?.checks ?? []).find((c) => !c.ok)
  if (!bad) return 'verify failed'
  return `${bad.target}: ${bad.actual}`
}

function evidenceOf(verdict) {
  if (!verdict || !Array.isArray(verdict.checks)) return []
  return verdict.checks
    .filter((c) => c.ok)
    .slice(0, 8)
    .map((c) => `${c.type} ${c.target} ${c.actual}`)
}

export { validateGoal }
