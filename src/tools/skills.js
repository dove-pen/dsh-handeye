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
    const title = substituteDeep(String(step.intent ?? step.tool ?? 'unnamed step'), params, missing)
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
        if (!skillId) return fail('skill_use needs skillId')

        const found = await skills.get(skillId)
        if (!found.ok) return fail(`Skill not found: ${skillId} (run the skills command to list what exists)`)
        const skill = found.value

        const params = args?.params && typeof args.params === 'object' ? { ...args.params } : {}
        // 必填参数缺了直接拒：不猜、不留空占位符
        const missingRequired = (skill.params ?? []).filter((p) => p.required && !(p.name in params)).map((p) => p.name)
        if (missingRequired.length) {
          return fail(`Missing params: ${missingRequired.map((n) => `{{${n}}}`).join(', ')}. Provide them and call again.`)
        }

        const { steps, missing } = stepsFromSkill(skill, params)
        if (missing.length) {
          return fail(`Steps reference params that were not provided: ${missing.map((n) => `{{${n}}}`).join(', ')}`)
        }
        if (!steps.length) return fail('This skill has no steps')

        const created = await goals.create({
          title: skill.title,
          longTermGoal: `Skill ${skillId}: ${skill.title}`,
          steps,
          meta: { skillId, skillVersion: skill.version ?? 1, params },
        })
        if (!created.ok) return fail(`Failed to create goal: ${created.message}`)

        const goal = created.value
        // 和目标层保持一致：建目标即聚焦，之后必须按步骤走
        state.goalId = goal.id

        const withoutChecks = (skill.steps ?? []).filter((s) => !s.expect).length
        const lines = [
          `Goal ${goal.id} created from skill "${skill.title}" (${goal.steps.length} steps)`,
          `First step: goal_step_enter ${goal.id} ${goal.steps[0].id}`,
        ]
        if (withoutChecks > 0) {
          lines.push(`Note: ${withoutChecks} steps have no acceptance checks - confirm the result yourself; health only tracks whether it finished.`)
        }
        lines.push('Finishing the last step updates skill health; getting blocked records a failure.')
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
          if (!got.ok) return fail(`Skill not found: ${skillId}`)
          const s = got.value
          const h = s.health ?? {}
          return [
            `${s.id}  ${s.title}`,
            `Used ${h.runs ?? 0} times · ok ${h.ok ?? 0} · fail ${h.fail ?? 0} · status ${h.status ?? 'untested'}`,
            h.lastFailReason ? `Last failure: ${h.lastFailReason}` : 'No failures recorded',
          ].join('\n')
        }
        const listed = await skills.list()
        if (!listed.ok) return fail(`Failed to read skills: ${listed.message}`)
        if (!listed.value.length) return 'No skills yet. Run the skills command to compile one from history.'
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
