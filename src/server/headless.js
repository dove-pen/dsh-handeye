// 无宿主启动：不依赖 DSH 的任何东西，把核心跑起来。
//
// CLI 和 MCP server 都从这里拿工具。刻意只有一条路径：
// 谁想在没有宿主的环境里调这些工具，就得走这里，门卫也就在同一处。

import { apply, getRuntime } from '../index.js'

/**
 * 启动一个无宿主的运行实例。
 * @returns {Promise<{tools: any[], listTools: Function, callTool: Function, version: string}>}
 */
export async function bootHeadless({ waitMs = 400 } = {}) {
  const tools = []
  const host = {
    tools: { register: (def) => tools.push(def) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: (fn) => {
      try {
        fn()
      } catch {}
    },
    // 没有 webServer：路由不注册。无宿主场景不需要面板
    inject: () => {},
    webServer: { register() {} },
  }

  apply(host)
  // episode 的 prune 之类是异步的，给运行时一点时间落定
  await new Promise((resolve) => setTimeout(resolve, waitMs))

  const byName = new Map(tools.map((t) => [t.name, t]))

  return {
    tools,
    // 适配层要拿它做"允许一次"（破坏性动作的确认）；没有它 MCP 下只能拒绝
    runtime: getRuntime(),
    listTools: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      })),
    callTool: async (name, args) => {
      const tool = byName.get(String(name))
      if (!tool) return { ok: false, text: `失败：没有这个工具 ${name}` }
      try {
        const out = await tool.execute(args ?? {}, null)
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
        return { ok: !(text.startsWith('Refused:') || text.includes('失败：')), text }
      } catch (error) {
        return { ok: false, text: `失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
