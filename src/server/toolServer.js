// 主机无关的工具外壳。
//
// 这里是"层"的核心：工具怎么被调用、门卫怎么拦、记账怎么记，全在这里。
// DSH 插件、MCP server、CLI 都是薄薄一层，把工具从这里转出去而已 ——
// 门卫必须活在这个 callTool 里，不能活在任何一个适配器里，
// 否则每个宿主一套门，其中几套一定是漏的。

export function createToolServer({ ports = {} } = {}) {
  const tools = new Map()

  const need = (name) => {
    const fn = ports[name]
    if (typeof fn !== 'function') throw new Error(`toolServer: missing port "${name}"`)
    return fn
  }

  /**
   * 把工具定义包一层：调用前过门卫，调用后记账。
   * 逻辑必须与历史版本逐字一致（行为零变化是 M1 的验收标准）。
   */
  function wrap(def) {
    const original = def.execute

    const wrapped = {
      ...def,
      async execute(args, exec) {
        const started = Date.now()
        const name = def.name
        const runtime = typeof ports.runtime === 'function' ? ports.runtime() : null
        const meta = need('isMetaTool')(name)

        // 动作前的唯一闸门：暂停 / 重规划 / 工具白名单 / 预算 / 破坏性确认
        if (runtime && !meta) {
          let verdict = need('canAct')(runtime.state, name, args ?? {})
          if (!verdict.ok && verdict.code === 'CONFIRM_REQUIRED') {
            // 用户刚在面板上点了"允许一次" -> 放行这一次
            if (need('takeGrant')(name)) verdict = { ok: true, code: 'CONFIRMED', risk: verdict.risk }
            else need('notePendingConfirm')(name, args ?? {})
          }
          if (!verdict.ok) {
            need('noteRefusal')(verdict.code)
            const message = `Refused: ${verdict.code}${verdict.message ? ` — ${verdict.message}` : ''}`
            need('recordActivity')(name, args, false, message, 0)
            return message
          }
        }

        try {
          const out = await original(args, exec)
          // 工具自己把错误 catch 成字符串返回，所以不能只看有没有 throw；
          // 统一约定：fail() 产出的话里带"失败："，据此标记失败。
          const failed = typeof out === 'string' && out.includes('失败：')
          need('recordActivity')(name, args, !failed, out, Date.now() - started)

          if (runtime && !meta) {
            const active = typeof ports.active === 'function' ? ports.active() : null
            if (active) {
              active.steps.push({
                seq: active.steps.length + 1,
                tool: name,
                args: need('redactDeep')(args ?? {}),
                ok: !failed,
                ms: Date.now() - started,
                brief: need('redactText')(need('clip')(out, 300)),
              })
            }
            // 目标类工具是"管理状态"，不是"动屏幕"，不计入动作预算与路径打卡
            const manageOnly = name.startsWith('goal_')
            if (!manageOnly && name !== 'capability' && need('isActionTool')(name, args ?? {}) && runtime.state.state === 'RUNNING') {
              const trip = need('noteAction')(runtime.state, name, args ?? {}, !failed)
              // 目标步骤的动作预算：每个真动作都算一次
              if (runtime.state.currentStep) need('countStepAction')(runtime.state)
              if (trip.tripped) return `${out}\n\n[PAUSED] ${trip.reason}`
            }
          }
          return out
        } catch (e) {
          need('recordActivity')(name, args, false, e instanceof Error ? e.message : e, Date.now() - started)
          throw e
        }
      },
    }

    tools.set(def.name, wrapped)
    return wrapped
  }

  return {
    wrap,
    /** 给 MCP / 文档用的清单：名称、说明、参数 schema。 */
    listTools: () =>
      [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      })),
    /** 宿主无关的唯一入口。门卫就在这里面。 */
    async callTool(name, args = {}, exec = null) {
      const tool = tools.get(String(name))
      if (!tool) return `失败：没有这个工具 ${name}`
      return tool.execute(args ?? {}, exec)
    },
    has: (name) => tools.has(String(name)),
    get size() {
      return tools.size
    },
  }
}
