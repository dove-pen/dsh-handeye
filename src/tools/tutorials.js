// 教程工具：让「用户写的步骤」变成 AI 真能照着做的事。
//
// 教程和技能的区别只在一个字：**谁写的**。
//   - 技能：从 episode 里编译出来的（机器总结）
//   - 教程：用户手写的（人写的卡片：goal / path / constraints / success / verify）
//
// 两者走同一条执行通道 —— 编译成「目标」，交给目标层的步骤门与验收门。

import { fail, text } from './util.js'

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g

function substitute(value, params, missing = new Set()) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_, name) => {
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        missing.add(name)
        return `{{${name}}}`
      }
      return String(params[name])
    })
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params, missing))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, params, missing)
    return out
  }
  return value
}

/** 卡片 path → 目标步骤；判据挂在最后一步（整体验收，不是每步验收）。 */
export function stepsFromTutorial(card, params = {}) {
  const missing = new Set()
  const path = Array.isArray(card.path) ? card.path : []
  const steps = path.map((entry) => {
    const title = typeof entry === 'string' ? entry : String(entry?.title ?? 'unnamed step')
    return { title: substitute(title, params, missing), verify: null }
  })
  if (steps.length && Array.isArray(card.verify) && card.verify.length) {
    steps[steps.length - 1].verify = substitute(card.verify, params, missing)
  }
  return { steps, missing: [...missing] }
}

function requiredParams(card) {
  const params = card.params || {}
  return Object.entries(params)
    .filter(([, desc]) => desc && desc.required)
    .map(([name]) => name)
}

/**
 * 开始一份教程：编译成目标。工具（tutorial_start）和面板按钮都走这里，
 * 保证"人点的"和"模型点的"是同一条路。
 * @returns {Promise<{ok:true, goalId:string, firstStep:string, stepCount:number, lines:string[]}|{ok:false, error:string}>}
 */
export async function startTutorial({ state, cards, goals }, id, params = {}) {
  const tutorialId = String(id ?? '').trim()
  if (!tutorialId) return { ok: false, error: 'tutorialId is required' }

  const got = await cards.get(tutorialId)
  if (!got.ok) return { ok: false, error: 'Tutorial not found: ' + tutorialId }
  const card = got.value
  if (card.enabled === false) return { ok: false, error: 'Tutorial ' + tutorialId + ' is disabled' }

  const values = params && typeof params === 'object' ? { ...params } : {}
  const need = requiredParams(card).filter((name) => !(name in values))
  if (need.length) return { ok: false, error: 'Missing params: ' + need.map((n) => '{{' + n + '}}').join(', ') }

  const { steps, missing } = stepsFromTutorial(card, values)
  if (missing.length) return { ok: false, error: 'Steps reference params that were not provided: ' + missing.join(', ') }
  if (!steps.length) return { ok: false, error: 'This tutorial has no steps' }

  const created = await goals.create({
    title: card.title,
    longTermGoal: card.goal,
    steps,
    meta: { tutorialId: card.id, tutorialVersion: card.version ?? 1, params: values },
  })
  if (!created.ok) return { ok: false, error: 'Failed to create goal: ' + created.message }

  const goal = created.value
  if (state) state.goalId = goal.id
  return { ok: true, goalId: goal.id, firstStep: goal.steps[0].id, stepCount: steps.length, card }
}

export function createTutorialTools({ state, cards, goals }) {
  return [
    {
      name: 'tutorial_list',
      description:
        'List the user-written tutorials (cards): id, title, steps, whether they carry acceptance checks, and how they have performed. Tutorials are how the user teaches you a procedure — read one before improvising.',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute() {
        const listed = await cards.list()
        if (!listed.ok) return fail(`Failed to read tutorials: ${listed.message}`)
        const list = listed.value ?? []
        if (!list.length) return 'No tutorials yet. The user can write one in the panel.'
        return list
          .map((c) => {
            const h = c.health || {}
            const checks = Array.isArray(c.verify) && c.verify.length ? `${c.verify.length} checks` : 'no checks'
            return `${c.id}  ${c.title}  ${(c.path ?? []).length} steps · ${checks} · ran ${h.runs ?? 0} times (ok ${h.ok ?? 0} / fail ${h.fail ?? 0})`
          })
          .join('\n')
      },
    },

    {
      name: 'tutorial_get',
      description: 'Read one tutorial in full: goal, ordered steps, constraints, success criteria and acceptance checks.',
      parameters: {
        type: 'object',
        properties: { tutorialId: { type: 'string', description: 'Tutorial (card) id.' } },
        required: ['tutorialId'],
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const id = text(args?.tutorialId).trim()
        if (!id) return fail('tutorial_get tutorialId is required')
        const got = await cards.get(id)
        if (!got.ok) return fail(`Tutorial not found: ${id}`)
        const c = got.value
        const lines = [
          `# ${c.title}（${c.id}）`,
          `Goal: ${c.goal}`,
          '',
          'Steps:',
          ...(c.path ?? []).map((s, i) => `${i + 1}. ${s}`),
        ]
        if ((c.constraints ?? []).length) {
          lines.push('', 'Constraints:', ...c.constraints.map((x) => `- ${x}`))
        }
        if (c.success) lines.push('', `Success: ${c.success}`)
        if (c.onFailure) lines.push(`On failure: ${c.onFailure}`)
        if (Array.isArray(c.verify) && c.verify.length) {
          lines.push('', 'Acceptance checks:', ...c.verify.map((v) => `- ${describeCheck(v)}`))
        }
        const h = c.health || {}
        lines.push('', `Health: ran ${h.runs ?? 0}, ok ${h.ok ?? 0}, fail ${h.fail ?? 0}, status ${h.status ?? 'untested'}`)
        return lines.join('\n')
      },
    },

    {
      name: 'tutorial_start',
      description:
        'Follow a tutorial: compile it into a goal (steps from the tutorial path, acceptance checks on the last step). After this, work the goal normally with goal_step_enter / goal_step_done. Finishing or getting blocked updates the tutorial health.',
      parameters: {
        type: 'object',
        properties: {
          tutorialId: { type: 'string', description: 'Tutorial (card) id.' },
          params: { type: 'object', description: 'Values for {{placeholders}} in the steps.' },
        },
        required: ['tutorialId'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const id = text(args?.tutorialId).trim()
        if (!id) return fail('tutorial_start tutorialId is required')

        const got = await cards.get(id)
        if (!got.ok) return fail(`Tutorial not found: ${id} (use tutorial_list to see what exists)`)
        const card = got.value

        if (card.enabled === false) return fail(`Tutorial ${id} is disabled; enable it first`)

        const params = args?.params && typeof args.params === 'object' ? { ...args.params } : {}
        const need = requiredParams(card).filter((name) => !(name in params))
        if (need.length) {
          return fail(`Missing params: ${need.map((n) => `{{${n}}}`).join(', ')}`)
        }

        const { steps, missing } = stepsFromTutorial(card, params)
        if (missing.length) return fail(`Steps reference params that were not provided: ${missing.map((n) => `{{${n}}}`).join(', ')}`)
        if (!steps.length) return fail('This tutorial has no steps')

        const created = await goals.create({
          title: card.title,
          longTermGoal: card.goal,
          steps,
          meta: { tutorialId: card.id, tutorialVersion: card.version ?? 1, params },
        })
        if (!created.ok) return fail(`Failed to create goal: ${created.message}`)

        const goal = created.value
        state.goalId = goal.id

        const hasChecks = steps.some((s) => Array.isArray(s.verify) && s.verify.length)
        const lines = [
          `Goal ${goal.id} created from tutorial "${card.title}" (${steps.length} steps)`,
          `First step: goal_step_enter ${goal.id} ${goal.steps[0].id}`,
        ]
        if ((card.constraints ?? []).length) lines.push(`Constraints: ${card.constraints.join('; ')}`)
        if (!hasChecks) lines.push('Note: this tutorial has no acceptance checks; confirm the result yourself.')
        lines.push('Finishing the last step updates this tutorial health; getting blocked records a failure.')
        return lines.join('\n')
      },
    },
  ]
}

function describeCheck(check) {
  if (!check) return '(empty)'
  if (check.type === 'file') return `file ${check.path} exists${check.minBytes ? ` and >= ${check.minBytes} bytes` : ''}`
  if (check.type === 'text') return `${check.file ? `file ${check.file} ` : 'screen '}contains "${check.appear ?? check.absent}"`
  if (check.type === 'screen') return `text "${check.appear}" appears on screen`
  if (check.type === 'exit') return `command ${check.command} exits 0`
  if (check.type === 'changed') return 'screen changed'
  return check.type
}
