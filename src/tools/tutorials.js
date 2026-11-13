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
    const title = typeof entry === 'string' ? entry : String(entry?.title ?? '未命名步骤')
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
  if (!tutorialId) return { ok: false, error: '需要 tutorialId' }

  const got = await cards.get(tutorialId)
  if (!got.ok) return { ok: false, error: '找不到教程 ' + tutorialId }
  const card = got.value
  if (card.enabled === false) return { ok: false, error: '教程 ' + tutorialId + ' 现在是停用状态' }

  const values = params && typeof params === 'object' ? { ...params } : {}
  const need = requiredParams(card).filter((name) => !(name in values))
  if (need.length) return { ok: false, error: '还缺参数：' + need.map((n) => '{{' + n + '}}').join('、') }

  const { steps, missing } = stepsFromTutorial(card, values)
  if (missing.length) return { ok: false, error: '步骤里用到了没提供的参数：' + missing.join('、') }
  if (!steps.length) return { ok: false, error: '这份教程没有步骤' }

  const created = await goals.create({
    title: card.title,
    longTermGoal: card.goal,
    steps,
    meta: { tutorialId: card.id, tutorialVersion: card.version ?? 1, params: values },
  })
  if (!created.ok) return { ok: false, error: '建目标失败：' + created.message }

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
        if (!listed.ok) return fail(`读教程库失败：${listed.message}`)
        const list = listed.value ?? []
        if (!list.length) return '教程库是空的。用户可以在面板里写一份教程。'
        return list
          .map((c) => {
            const h = c.health || {}
            const checks = Array.isArray(c.verify) && c.verify.length ? `${c.verify.length} 条判据` : '无判据'
            return `${c.id}  ${c.title}  ${(c.path ?? []).length} 步 · ${checks} · 跑了 ${h.runs ?? 0} 次（成功 ${h.ok ?? 0} / 失败 ${h.fail ?? 0}）`
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
        if (!id) return fail('tutorial_get 需要 tutorialId')
        const got = await cards.get(id)
        if (!got.ok) return fail(`找不到教程 ${id}`)
        const c = got.value
        const lines = [
          `# ${c.title}（${c.id}）`,
          `目标：${c.goal}`,
          '',
          '步骤：',
          ...(c.path ?? []).map((s, i) => `${i + 1}. ${s}`),
        ]
        if ((c.constraints ?? []).length) {
          lines.push('', '约束：', ...c.constraints.map((x) => `- ${x}`))
        }
        if (c.success) lines.push('', `判定成功：${c.success}`)
        if (c.onFailure) lines.push(`失败时：${c.onFailure}`)
        if (Array.isArray(c.verify) && c.verify.length) {
          lines.push('', '验收判据：', ...c.verify.map((v) => `- ${describeCheck(v)}`))
        }
        const h = c.health || {}
        lines.push('', `健康度：跑了 ${h.runs ?? 0} 次，成功 ${h.ok ?? 0}，失败 ${h.fail ?? 0}，状态 ${h.status ?? 'untested'}`)
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
        if (!id) return fail('tutorial_start 需要 tutorialId')

        const got = await cards.get(id)
        if (!got.ok) return fail(`找不到教程 ${id}（先用 tutorial_list 看看有哪些）`)
        const card = got.value

        if (card.enabled === false) return fail(`教程 ${id} 现在是停用状态，先启用再跑`)

        const params = args?.params && typeof args.params === 'object' ? { ...args.params } : {}
        const need = requiredParams(card).filter((name) => !(name in params))
        if (need.length) {
          return fail(`这份教程还缺参数：${need.map((n) => `{{${n}}}`).join('、')}`)
        }

        const { steps, missing } = stepsFromTutorial(card, params)
        if (missing.length) return fail(`步骤里用到了没提供的参数：${missing.map((n) => `{{${n}}}`).join('、')}`)
        if (!steps.length) return fail('这份教程没有步骤，不能用')

        const created = await goals.create({
          title: card.title,
          longTermGoal: card.goal,
          steps,
          meta: { tutorialId: card.id, tutorialVersion: card.version ?? 1, params },
        })
        if (!created.ok) return fail(`建目标失败：${created.message}`)

        const goal = created.value
        state.goalId = goal.id

        const hasChecks = steps.some((s) => Array.isArray(s.verify) && s.verify.length)
        const lines = [
          `已按教程「${card.title}」建立目标 ${goal.id}（${steps.length} 步）`,
          `第一步：goal_step_enter ${goal.id} ${goal.steps[0].id}`,
        ]
        if ((card.constraints ?? []).length) lines.push(`约束：${card.constraints.join('；')}`)
        if (!hasChecks) lines.push('注意：这份教程没写验收判据，做完只能靠你自己确认。')
        lines.push('跑完最后一步会回写这份教程的健康度；卡住会记一次失败。')
        return lines.join('\n')
      },
    },
  ]
}

function describeCheck(check) {
  if (!check) return '（空）'
  if (check.type === 'file') return `文件 ${check.path} 存在${check.minBytes ? ` 且 ≥ ${check.minBytes} 字节` : ''}`
  if (check.type === 'text') return `${check.file ? `文件 ${check.file} ` : '屏幕'}出现「${check.appear ?? check.absent}」`
  if (check.type === 'screen') return `屏幕出现「${check.appear}」`
  if (check.type === 'exit') return `命令 ${check.command} 退出码 0`
  if (check.type === 'changed') return '画面有变化'
  return check.type
}
