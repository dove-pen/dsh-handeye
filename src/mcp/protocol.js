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
export function createMcpHandler({ listTools, callTool, info, request, grant }) {
  const serverInfo = { name: info?.name ?? 'handeye', version: info?.version ?? '0.0.0' }
  // 客户端在 initialize 里声明了 elicitation，才能弹确认；否则退回"直接拒绝"
  let clientElicitation = false

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
          clientElicitation = Boolean(params && params.capabilities && params.capabilities.elicitation)
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

          let result = await callTool(name, args)
          let text = String(result?.text ?? '')

          // 破坏性动作：门卫会 Refused: CONFIRM_REQUIRED。
          // 如果客户端支持 elicitation，就在这里请宿主弹一次确认；用户点允许才重试一次。
          if (result?.ok === false && text.startsWith('Refused: CONFIRM_REQUIRED') && clientElicitation && typeof request === 'function' && typeof grant === 'function') {
            let answer = null
            try {
              answer = await request('elicitation/create', {
                message: `AI 想执行「${name}」，这看起来是破坏性操作。要允许这一次吗？`,
                requestedSchema: {
                  type: 'object',
                  properties: { approve: { type: 'boolean', title: '允许一次', description: '只对这一个动作、只生效一次' } },
                  required: ['approve'],
                },
              })
            } catch (error) {
              return okResponse(id, {
                content: [{ type: 'text', text: `需要用户确认，但宿主没能弹窗（${error instanceof Error ? error.message : String(error)}）。请让用户在本机执行：node bin/he-server.js confirm ${name}` }],
                isError: true,
              })
            }
            if (answer && answer.action === 'accept') {
              if (!grant(name)) {
                return okResponse(id, { content: [{ type: 'text', text: '确认通道不可用：没能写入一次性授权。' }], isError: true })
              }
              result = await callTool(name, args)
              text = String(result?.text ?? '')
            } else {
              return okResponse(id, { content: [{ type: 'text', text: '用户拒绝了这个动作。' }], isError: true })
            }
          }

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
