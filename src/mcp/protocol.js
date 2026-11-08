// MCP 协议层：把 JSON-RPC 消息翻成 core 调用。
//
// 刻意做成纯函数（输入一条消息、返回一条响应），不碰 stdin/stdout ——
// 这样协议行为可以单测，不用起子进程。

export const PROTOCOL_VERSION = '2025-06-18'

const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

/**
 * @param {{listTools: Function, callTool: Function, info: {name:string, version:string}}} deps
 * @returns {(msg: object) => Promise<object|null>} 返回 null 表示无需回包（通知）
 */
export function createMcpHandler({ listTools, callTool, info }) {
  const serverInfo = { name: info?.name ?? 'handeye', version: info?.version ?? '0.0.0' }

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return errorResponse(null, ERROR.invalidRequest, 'expected a single JSON-RPC message')
    }

    const { id, method, params } = msg
    const isNotification = id === undefined || id === null

    // 通知一律不回包（MCP 里 notifications/initialized、notifications/cancelled 都是通知）
    if (isNotification) {
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
      return null
    }

    if (!method || typeof method !== 'string') {
      return errorResponse(id, ERROR.invalidRequest, 'missing method')
    }

    try {
      switch (method) {
        case 'initialize': {
          // 回显客户端请求的版本：MCP 的版本协商由客户端主导
          const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION
          return okResponse(id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions:
              '这台机器上的手眼工具。所有动作都过门卫：暂停/步骤/预算/破坏性确认被拒绝时，会以 isError 返回并说明原因。',
          })
        }

        case 'ping':
          return okResponse(id, {})

        case 'tools/list':
          return okResponse(id, {
            tools: listTools().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          })

        case 'tools/call': {
          const name = params && typeof params.name === 'string' ? params.name : ''
          const args = params && typeof params.arguments === 'object' && params.arguments ? params.arguments : {}
          if (!name) return errorResponse(id, ERROR.invalidParams, 'tools/call needs params.name')

          const result = await callTool(name, args)
          const text = String(result?.text ?? '')
          const isError = result?.ok === false
          return okResponse(id, {
            content: [{ type: 'text', text }],
            // 门卫拒绝和工具失败都标 isError：宿主会把它当"这次没成"，不会当成功
            isError,
          })
        }

        // 没实现但客户端可能会问的
        case 'resources/list':
          return okResponse(id, { resources: [] })
        case 'prompts/list':
          return okResponse(id, { prompts: [] })
        case 'resources/templates/list':
          return okResponse(id, { resourceTemplates: [] })

        default:
          return errorResponse(id, ERROR.methodNotFound, `unknown method: ${method}`)
      }
    } catch (error) {
      return errorResponse(id, ERROR.internal, error instanceof Error ? error.message : String(error))
    }
  }
}
