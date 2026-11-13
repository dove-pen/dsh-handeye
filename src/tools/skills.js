// 技能工具：把一份技能变成一件能跑的事。
//
// 关键设计（S1 的核心决定）：**技能不另起执行器，直接编译成「目标」**。
// 目标层已经有步骤门、预算、判据、blocked、留痕；再造一套并行状态机，
// 就会第二次出现"门卫只有一半"的问题。
//
// 所以这里只做三件事：读技能 → 参数替换 → 交给目标层。

import { fail, text } from './util.js'

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g

/** 递归替换 {{name}}；返回 { value, missing }，缺参数不会静默留空。 */
export function substituteDeep(value, params, missing = new Set()) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_, name) => {
      const has = Object.prototype.hasOwnProperty.call(params, name)
      if (!has) {
        missing.add(name)
        return `{{${name}}}`
      }
      return String(params[name])
    })
  }
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params, missing))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, params, missing)
    return out
  }
  return value
}

/** 技能步骤 → 目标步骤（判据原样带过去）。 */
export function stepsFromSkill(skill, params = {}) {
  const missing = new Set()
  const steps = (skill.steps ?? []).map((step) => {
    const title = substituteDeep(String(step.intent ?? step.tool ?? '未命名步骤'), params, missing)
    const expect = step.expect
    const verify = expect ? (Array.isArray(expect) ? expect : [expect]) : null
    return { title, verify: substituteDeep(verify, params, missing) }
  })
  return { steps, missing: [...missing] }
}

export function createSkillTools({ state, skills, goals }) {
  const goalOf = async (id) => {
    const got = await goals.get(id)
    return got.ok ? got.value : null
  }

  return [
    {
      name: 'skill_use',
      description:
        'Run a saved skill by compiling it into a goal. Params fill {{placeholders}} in the steps. After this you work the goal normally: goal_step_enter, then goal_step_done. Skill health is updated automatically when the last step finishes or a step gets blocked.',
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: 'Skill id, e.g. skill_20261108_01.' },
          params: {
            type: 'object',
            description: 'Values for the skill parameters (e.g. { "url": "https://..." }). Missing required params are refused.',
          },
        },
        required: ['skillId'],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const skillId = text(args?.skillId).trim()
        if (!skillId) return fail('skill_use 需要 skillId')

        const found = await skills.get(skillId)
        if (!found.ok) return fail(`找不到技能 ${skillId}（先用 skills 命令看看有哪些）`)
        const skill = found.value

        const params = args?.params && typeof args.params === 'object' ? { ...args.params } : {}
        // 必填参数缺了直接拒：不猜、不留空占位符
        const missingRequired = (skill.params ?? []).filter((p) => p.required && !(p.name in params)).map((p) => p.name)
        if (missingRequired.length) {
          return fail(`这份技能还缺参数：${missingRequired.map((n) => `{{${n}}}`).join('、')}。补齐再调一次。`)
        }

        const { steps, missing } = stepsFromSkill(skill, params)
        if (missing.length) {
          return fail(`步骤里用到了没提供的参数：${missing.map((n) => `{{${n}}}`).join('、')}`)
        }
        if (!steps.length) return fail('这份技能没有步骤，不能用')

        const created = await goals.create({
          title: skill.title,
          longTermGoal: `技能 ${skillId}：${skill.title}`,
          steps,
          meta: { skillId, skillVersion: skill.version ?? 1, params },
        })
        if (!created.ok) return fail(`建目标失败：${created.message}`)

        const goal = created.value
        // 和目标层保持一致：建目标即聚焦，之后必须按步骤走
        state.goalId = goal.id

        const withoutChecks = (skill.steps ?? []).filter((s) => !s.expect).length
        const lines = [
          `已用技能「${skill.title}」建立目标 ${goal.id}（${goal.steps.length} 步）`,
          `第一步：goal_step_enter ${goal.id} ${goal.steps[0].id}`,
        ]
        if (withoutChecks > 0) {
          lines.push(`注意：${withoutChecks} 步没有验收判据 —— 做完只能靠你自己确认，健康度只记"跑没跑完"。`)
        }
        lines.push('跑完最后一步会回写技能健康度；中途卡住会记一次失败。')
        return lines.join('\n')
      },
    },

    {
      name: 'skill_health',
      description: 'Show a skill health record: runs / ok / fail / status / last failure reason.',
      parameters: {
        type: 'object',
        properties: { skillId: { type: 'string', description: 'Skill id. Omit to list all skills.' } },
      },
      timeoutMs: 10000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const skillId = text(args?.skillId).trim()
        if (skillId) {
          const got = await skills.get(skillId)
          if (!got.ok) return fail(`找不到技能 ${skillId}`)
          const s = got.value
          const h = s.health ?? {}
          return [
            `${s.id}  ${s.title}`,
            `用了 ${h.runs ?? 0} 次 · 成功 ${h.ok ?? 0} · 失败 ${h.fail ?? 0} · 状态 ${h.status ?? 'untested'}`,
            h.lastFailReason ? `上次失败：${h.lastFailReason}` : '没有失败记录',
          ].join('\n')
        }
        const listed = await skills.list()
        if (!listed.ok) return fail(`读技能库失败：${listed.message}`)
        if (!listed.value.length) return '技能库是空的。先用 skills 命令从历史里编译一份。'
        return listed.value
          .map((s) => {
            const h = s.health ?? {}
            return `${s.id}  ${s.title}  runs=${h.runs ?? 0} ok=${h.ok ?? 0} fail=${h.fail ?? 0} ${h.status ?? 'untested'}`
          })
          .join('\n')
      },
    },
  ]
}
