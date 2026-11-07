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
  const bits = [`${summary.done}/${summary.total} 步`]
  if (summary.doing) bits.push(`进行中 ${summary.doing}`)
  if (summary.blocked) bits.push(`卡住 ${summary.blocked}`)
  else if (summary.next) bits.push(`下一步 ${summary.next}`)
  return bits.join(' · ')
}

function stepLine(step) {
  const mark = { todo: '○', doing: '▸', done: '✓', blocked: '×', skipped: '-' }[step.status] || '?'
  const prompt = step.promptId ? ` [${step.promptId}]` : ''
  return `${mark} ${step.id} ${step.title}${prompt}`
}

export function createGoalTools({ state, goals, verifyStep, onStepEnter, onStepLeave }) {
  const fail = (message) => `失败：${message}`

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
        if (!created.ok) return fail(`建目标没成功：${created.message}${created.errors ? ' ' + JSON.stringify(created.errors.slice(0, 3)) : ''}`)
        const doc = created.value
        // 建目标即"采用"：从这一刻起，写操作必须先 goal_step_enter，否则步骤门会拒。
        state.goalId = doc.id
        const lines = [`已建目标 ${doc.id}：${doc.title}`, `长期目标：${doc.longTermGoal}`]
        if (doc.steps.length > 0) {
          lines.push(`步骤（${doc.steps.length}）：`)
          for (const step of doc.steps) lines.push(`  ${stepLine(step)}`)
          lines.push('下一步：goal_step_enter 选一步开始。')
        } else {
          lines.push('还没有步骤：用 goal_plan 写出 3~7 步。')
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
        if (!id) return fail('goal_plan 需要 goalId')
        const steps = Array.isArray(args?.steps) ? args.steps : []
        if (steps.length === 0) return fail('至少要有一个步骤')
        const saved = await goals.setPlan(id, steps)
        if (!saved.ok) return fail(`写步骤没成功：${saved.message}${saved.errors ? ' ' + JSON.stringify(saved.errors.slice(0, 3)) : ''}`)
        const doc = saved.value
        state.goalId = doc.id
        const lines = [`目标 ${doc.id} 的步骤已更新（${doc.steps.length} 步）：`]
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
          if (active.length === 0) return '还没有任何目标。用 goal_create 建一个。'
          return active
            .map((g) => {
              const s = summarizeGoal(g)
              return `${g.status === 'active' ? '●' : '○'} ${g.id}  ${g.title}  ${progressLine(s)}`
            })
            .join('\n')
        }
        const doc = await goalOf(id)
        if (!doc) return fail(`找不到目标 ${id}`)
        const s = summarizeGoal(doc)
        const lines = [
          `目标 ${doc.id}（${doc.status}）：${doc.title}`,
          `长期目标：${doc.longTermGoal}`,
          `进度：${progressLine(s)}`,
          '步骤：',
        ]
        for (const step of doc.steps) {
          lines.push(`  ${stepLine(step)}  attempts=${step.attempts ?? 0} verifyFailures=${step.verifyFailures ?? 0}`)
          if (step.verify && step.verify.length) lines.push(`      验收：${JSON.stringify(step.verify)}`)
          if (step.status === 'blocked' && step.blocks?.length) lines.push(`      卡住原因：${step.blocks[step.blocks.length - 1].reason}`)
        }
        const runs = (doc.runs ?? []).slice(-5)
        if (runs.length) {
          lines.push('最近记录：')
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
        if (!goalId || !stepId) return fail('goal_step_enter 需要 goalId 和 stepId')

        const entered = await goals.enterStep(goalId, stepId, {
          promptId: typeof args?.promptId === 'string' ? args.promptId.trim() : undefined,
        })
        if (!entered.ok) return fail(`进不了这一步：${entered.message}`)

        const { goal, step } = entered.value
        let info = null
        if (typeof onStepEnter === 'function') {
          info = await onStepEnter({ goal, step, params: args?.params && typeof args.params === 'object' ? args.params : {} })
        }
        const budget = step.budget?.actions ?? DEFAULT_STEP_BUDGET
        const lines = [
          `已进入 ${goal.title} 的 ${step.id}：${step.title}`,
          `预算：${budget} 个动作（超了会被拦，需要 goal_step_continue 续）`,
        ]
        if (info?.episodeId) lines.push(`episode=${info.episodeId}`)
        if (info?.checks) lines.push(`验收：${info.checks} 条（不通过不会推进）`)
        lines.push(`完成时用 goal_step_done，不要直接喊完成。`)
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
        if (!goalId || !stepId) return fail('goal_step_done 需要 goalId 和 stepId')
        if (!summary) return fail('goal_step_done 需要一句 summary，说明这步到底做了什么')

        const doc = await goalOf(goalId)
        if (!doc) return fail(`找不到目标 ${goalId}`)
        const step = doc.steps.find((s) => s.id === stepId)
        if (!step) return fail(`目标里没有步骤 ${stepId}`)
        if (step.status !== 'doing') return fail(`步骤 ${stepId} 当前是 ${step.status}，不是 doing`)

        let verdict = null
        if (typeof verifyStep === 'function') {
          verdict = await verifyStep(state)
        }
        if (verdict && verdict.ok === false) {
          const recorded = await goals.recordVerifyFailure(goalId, stepId, firstFailure(verdict))
          const blocked = Boolean(recorded.ok && recorded.value?.blocked)
          // 只有真被 blocked 才离开这一步；只挂一次的话步骤还是 doing，
          // 否则模型会丢掉步骤绑定，接着动手就会被步骤门拒得莫名其妙。
          if (blocked && typeof onStepLeave === 'function') {
            await onStepLeave({ goalId, stepId, reason: 'verify-failed' })
          }
          const lines = [
            '失败：这一步的验收没过，步骤没有完成。',
            formatChecks(verdict),
            '把上面"实际"那一栏对应的东西做出来，再调一次 goal_step_done。',
          ]
          if (blocked) {
            lines.push('')
            lines.push(`这已经是第 2 次没过，步骤 ${stepId} 已标记为 blocked，动作被锁住。`)
            lines.push('现在必须由人决定：goal_skip_step 跳过、换提示词重来、或手工放行后再试。不要自己换办法硬刚。')
          }
          return lines.join('\n')
        }

        const finished = await goals.finishStep(goalId, stepId, { result: 'ok', evidence: evidenceOf(verdict) })
        if (!finished.ok) return fail(`收尾没成功：${finished.message}`)
        await goals.appendRun(goalId, {
          stepId,
          promptId: step.promptId ?? null,
          episodeId: state.episodeId || null,
          verify: verdict?.overridden ? 'override' : verdict ? 'pass' : 'none',
          summary,
        })
        if (typeof onStepLeave === 'function') await onStepLeave({ goalId, stepId, reason: 'done' })

        const after = finished.value.goal
        const summaryLine = summarizeGoal(after)
        const lines = [`✓ 完成 ${stepId}：${step.title}`]
        if (verdict?.overridden) lines.push('（本次是人工放行，验收没有跑）')
        lines.push(`目标进度：${progressLine(summaryLine)}`)
        const next = after.steps.find((s) => s.status === 'todo')
        if (next) lines.push(`下一步：goal_step_enter ${goalId} ${next.id}`)
        else lines.push('所有步骤都做完了，可以用 goal_status 复核一遍。')
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
        if (!goalId || !stepId) return fail('goal_step_continue 需要 goalId 和 stepId')
        if (reason.length < 4) return fail('说明一下为什么要续（至少 4 个字），这条会写进记录')
        const extra = Math.min(40, Math.max(1, Number.isInteger(args?.extra) ? args.extra : DEFAULT_STEP_BUDGET))

        const doc = await goalOf(goalId)
        if (!doc) return fail(`找不到目标 ${goalId}`)
        const step = doc.steps.find((s) => s.id === stepId)
        if (!step) return fail(`目标里没有步骤 ${stepId}`)
        if (step.status !== 'doing') return fail(`步骤 ${stepId} 当前是 ${step.status}，不是 doing`)

        const rolled = await goals.save({
          ...doc,
          steps: doc.steps.map((s) =>
            s.id === stepId ? { ...s, budget: { actions: Number(s.budget?.actions ?? DEFAULT_STEP_BUDGET) + extra } } : s,
          ),
        })
        if (!rolled.ok) return fail(`续预算没成功：${rolled.message}`)
        if (typeof state.grantStepBudget === 'function') state.grantStepBudget(extra)
        await goals.appendRun(goalId, { stepId, kind: 'budget-extend', extra, reason })
        return `已给 ${stepId} 追加 ${extra} 个动作（原因：${reason}）。这条记录用户能看到。`
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
        if (!goalId) return fail('goal_set_status 需要 goalId')
        const saved = await goals.setStatus(goalId, status)
        if (!saved.ok) return fail(`改状态没成功：${saved.message}`)
        if (status !== 'active' && typeof onStepLeave === 'function') {
          await onStepLeave({ goalId, stepId: state.currentStep?.stepId ?? null, reason: status })
        }
        if (status !== 'active' && state.goalId === goalId) state.goalId = ''
        const summary = summarizeGoal(saved.value)
        return `目标 ${goalId} 现在是 ${status}（${summary.done}/${summary.total} 步）。`
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
        if (!goalId || !stepId) return fail('goal_skip_step 需要 goalId 和 stepId')
        if (reason.length < 4) return fail('跳过必须写原因（至少 4 个字），这条会写进记录')
        const skipped = await goals.skipStep(goalId, stepId, reason)
        if (!skipped.ok) return fail(`跳过没成功：${skipped.message}`)
        if (typeof onStepLeave === 'function') await onStepLeave({ goalId, stepId, reason: 'skipped' })
        const summary = summarizeGoal(skipped.value.goal)
        return `已跳过 ${stepId}（${reason}）。目标进度：${progressLine(summary)}`
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
