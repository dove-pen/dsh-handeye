import test from 'node:test'
import assert from 'node:assert/strict'

import { createMcpHandler, PROTOCOL_VERSION } from '../../src/mcp/protocol.js'

function makeHandler({ tools, calls = [] } = {}) {
  const listTools = () => tools ?? [
    { name: 'desk_windows', description: '列出窗口', parameters: { type: 'object', properties: {} } },
  ]
  const callTool = async (name, args) => {
    calls.push({ name, args })
    if (name === 'refuse_me') return { ok: false, text: 'Refused: PAUSED — user paused' }
    if (name === 'boom') throw new Error('explode')
    return { ok: true, text: `ok:${name}` }
  }
  return { handle: createMcpHandler({ listTools, callTool, info: { name: 'handeye', version: '9.9.9' } }), calls }
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })

test('initialize echoes the client protocol version and advertises tools', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(1, 'initialize', { protocolVersion: '2026-01-01' }))
  assert.equal(res.id, 1)
  assert.equal(res.result.protocolVersion, '2026-01-01')
  assert.deepEqual(res.result.capabilities.tools, { listChanged: false })
  assert.equal(res.result.serverInfo.name, 'handeye')
  assert.equal(res.result.serverInfo.version, '9.9.9')
})

test('initialize without a requested version falls back to our default', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(1, 'initialize', {}))
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION)
})

test('tools/list exposes inputSchema (MCP name for our parameters)', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(2, 'tools/list'))
  assert.equal(res.result.tools.length, 1)
  const tool = res.result.tools[0]
  assert.equal(tool.name, 'desk_windows')
  assert.equal(tool.inputSchema.type, 'object')
  assert.equal(tool.parameters, undefined, 'MCP 里叫 inputSchema，不能漏出内部的 parameters')
})

test('tools/call returns text content and no error on success', async () => {
  const { handle, calls } = makeHandler()
  const res = await handle(req(3, 'tools/call', { name: 'desk_windows', arguments: { a: 1 } }))
  assert.equal(res.result.isError, false)
  assert.equal(res.result.content[0].type, 'text')
  assert.equal(res.result.content[0].text, 'ok:desk_windows')
  assert.deepEqual(calls[0], { name: 'desk_windows', args: { a: 1 } })
})

test('a gate refusal is surfaced as isError, not as a success', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(4, 'tools/call', { name: 'refuse_me', arguments: {} }))
  assert.equal(res.result.isError, true, '门卫拒绝必须让宿主看到"这次没成"')
  assert.match(res.result.content[0].text, /^Refused: PAUSED/)
})

test('a tool that throws becomes a JSON-RPC error, server stays alive', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(5, 'tools/call', { name: 'boom', arguments: {} }))
  assert.equal(res.error.code, -32603)
  assert.match(res.error.message, /explode/)
  // 下一条消息还能处理
  const next = await handle(req(6, 'ping'))
  assert.deepEqual(next.result, {})
})

test('tools/call without a name is invalid params', async () => {
  const { handle } = makeHandler()
  const res = await handle(req(7, 'tools/call', { arguments: {} }))
  assert.equal(res.error.code, -32602)
})

test('unknown method is -32601; notifications get no response', async () => {
  const { handle } = makeHandler()
  const unknown = await handle(req(8, 'resources/read'))
  assert.equal(unknown.error.code, -32601)

  const notification = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notification, null, '通知不许回包')
})

test('malformed messages are rejected without throwing', async () => {
  const { handle } = makeHandler()
  assert.equal((await handle(null)).error.code, -32600)
  assert.equal((await handle([{ jsonrpc: '2.0' }])).error.code, -32600)
  assert.equal((await handle({ jsonrpc: '2.0', id: 9 })).error.code, -32600)
})

test('empty resource/prompt lists keep picky clients happy', async () => {
  const { handle } = makeHandler()
  assert.deepEqual((await handle(req(10, 'resources/list'))).result.resources, [])
  assert.deepEqual((await handle(req(11, 'prompts/list'))).result.prompts, [])
  assert.deepEqual((await handle(req(12, 'resources/templates/list'))).result.resourceTemplates, [])
})

// ---------------------------------------------------------------- 破坏性动作的确认

function confirmHandler({ action = 'accept', grantOk = true, capability = true } = {}) {
  const calls = []
  const requests = []
  let granted = false
  const handle = createMcpHandler({
    listTools: () => [{ name: 'hand_type', description: 'x', parameters: { type: 'object', properties: {} } }],
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (!granted) return { ok: false, text: 'Refused: CONFIRM_REQUIRED — destructive' }
      return { ok: true, text: 'typed' }
    },
    info: { name: 'handeye', version: '1' },
    request: async (method, params) => {
      requests.push({ method, params })
      return { action }
    },
    grant: (tool) => {
      if (!grantOk) return false
      granted = true
      return true
    },
  })
  return { handle, calls, requests, capability }
}

test('without client elicitation the refusal is passed straight through', async () => {
  const { handle, calls, requests } = confirmHandler()
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hand_type', arguments: { text: 'x' } } })
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /CONFIRM_REQUIRED/)
  assert.equal(requests.length, 0, '客户端没声明 elicitation，不许弹窗')
  assert.equal(calls.length, 1)
})

test('with elicitation accepted the tool is retried once and succeeds', async () => {
  const { handle, calls, requests } = confirmHandler({ action: 'accept' })
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } })
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hand_type', arguments: { text: 'x' } } })
  assert.equal(res.result.isError, false)
  assert.equal(res.result.content[0].text, 'typed')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'elicitation/create')
  assert.match(requests[0].params.message, /hand_type/)
  assert.equal(calls.length, 2, '第一次被拒、确认后重试一次')
})

test('with elicitation declined the action does not happen', async () => {
  const { handle, calls } = confirmHandler({ action: 'decline' })
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } })
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hand_type', arguments: { text: 'x' } } })
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /declined/)
  assert.equal(calls.length, 1, '拒绝了就不许重试')
})

test('if the grant cannot be written the action is still refused', async () => {
  const { handle, calls } = confirmHandler({ action: 'accept', grantOk: false })
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } })
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hand_type', arguments: { text: 'x' } } })
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /could not write a one-shot grant/)
  assert.equal(calls.length, 1)
})
