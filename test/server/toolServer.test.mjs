import test from 'node:test'
import assert from 'node:assert/strict'

import { createToolServer } from '../../src/server/toolServer.js'

/** 一套最小端口：模拟宿主侧的状态机与记账。 */
function makePorts(overrides = {}) {
  const log = { activity: [], refusals: [], actions: [], pending: [] }
  const state = { state: 'RUNNING', currentStep: null, episodeId: 'ep_x' }
  const active = { steps: [] }
  const ports = {
    runtime: () => ({ state }),
    active: () => active,
    isMetaTool: (n) => n.startsWith('episode_'),
    isActionTool: () => true,
    canAct: () => ({ ok: true, code: 'WRITE' }),
    takeGrant: () => false,
    notePendingConfirm: (tool) => log.pending.push(tool),
    noteRefusal: (code) => log.refusals.push(code),
    recordActivity: (tool, args, ok, brief, ms) => log.activity.push({ tool, ok, brief, ms }),
    redactDeep: (a) => a,
    redactText: (s) => s,
    clip: (s, n = 90) => String(s).slice(0, n),
    noteAction: () => ({ tripped: false }),
    countStepAction: () => log.actions.push(state.currentStep?.stepId ?? ''),
    ...overrides,
  }
  return { ports, log, state, active }
}

function simpleTool(execute) {
  return { name: 'demo_tool', description: 'demo', parameters: { type: 'object', properties: {} }, execute }
}

test('a clean call runs the tool and records activity', async () => {
  const { ports, log } = makePorts()
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => 'ok'))

  const out = await server.callTool('demo_tool', {})
  assert.equal(out, 'ok')
  assert.equal(log.activity.length, 1)
  assert.equal(log.activity[0].ok, true)
  assert.equal(log.refusals.length, 0)
})

test('a refusal short-circuits: the tool never runs', async () => {
  let ran = false
  const { ports, log } = makePorts({
    canAct: () => ({ ok: false, code: 'PAUSED', message: 'user paused' }),
  })
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => { ran = true; return 'ok' }))

  const out = await server.callTool('demo_tool', {})
  assert.equal(ran, false, '被拒的调用不许执行工具本体')
  assert.match(out, /^Refused: PAUSED — user paused$/)
  assert.deepEqual(log.refusals, ['PAUSED'])
  assert.equal(log.activity[0].ok, false)
})

test('destructive actions wait for a one-shot grant', async () => {
  let granted = false
  const { ports, log } = makePorts({
    canAct: () => (granted ? { ok: true, code: 'WRITE' } : { ok: false, code: 'CONFIRM_REQUIRED', risk: 'destructive' }),
    takeGrant: () => {
      if (!granted) return false
      granted = false // 用完即焚
      return true
    },
  })
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => 'done'))

  const first = await server.callTool('demo_tool', {})
  assert.match(first, /CONFIRM_REQUIRED/)
  assert.deepEqual(log.pending, ['demo_tool'], '要记下待确认的请求')

  granted = true
  const second = await server.callTool('demo_tool', {})
  assert.equal(second, 'done', '授权后放行一次')
  granted = false
  const third = await server.callTool('demo_tool', {})
  assert.match(third, /CONFIRM_REQUIRED/, '授权是一次性的')
})

test('episode steps and the step budget are recorded', async () => {
  const { ports, log, active, state } = makePorts()
  state.currentStep = { stepId: 's1' }
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => 'ok'))

  await server.callTool('demo_tool', { q: 1 })
  assert.equal(active.steps.length, 1)
  assert.equal(active.steps[0].tool, 'demo_tool')
  assert.deepEqual(log.actions, ['s1'], '步骤预算要计一次')
})

test('goal_* tools do not consume the step budget', async () => {
  const { ports, log, state } = makePorts()
  state.currentStep = { stepId: 's1' }
  const server = createToolServer({ ports })
  server.wrap({ ...simpleTool(async () => 'ok'), name: 'goal_status' })

  await server.callTool('goal_status', {})
  assert.deepEqual(log.actions, [], '管理类工具不计动作')
})

test('meta tools skip the gate entirely', async () => {
  let called = false
  const { ports } = makePorts({ canAct: () => { called = true; return { ok: false, code: 'PAUSED' } } })
  const server = createToolServer({ ports })
  server.wrap({ ...simpleTool(async () => 'ok'), name: 'episode_begin' })

  const out = await server.callTool('episode_begin', {})
  assert.equal(out, 'ok')
  assert.equal(called, false, 'meta 工具不该被门卫拦')
})

test('a tool that returns the legacy Chinese marker is still marked failed (dual-read)', async () => {
  const { ports, log } = makePorts()
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => '失败：文件不存在'))
  const out = await server.callTool('demo_tool', {})
  assert.equal(out, '失败：文件不存在')
  assert.equal(log.activity[0].ok, false)

  server.wrap({ ...simpleTool(async () => { throw new Error('boom') }), name: 'boom_tool' })
  await assert.rejects(() => server.callTool('boom_tool', {}), /boom/)
})

test('listTools exposes the schema, unknown tool fails clearly', async () => {
  const { ports } = makePorts()
  const server = createToolServer({ ports })
  server.wrap(simpleTool(async () => 'ok'))
  const list = server.listTools()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'demo_tool')
  assert.equal(list[0].parameters.type, 'object')

  const missing = await server.callTool('nope', {})
  assert.match(missing, /no such tool/)
})

test('missing ports fail loudly instead of silently allowing', () => {
  const server = createToolServer({ ports: {} })
  server.wrap(simpleTool(async () => 'ok'))
  return assert.rejects(() => server.callTool('demo_tool', {}), /missing port/)
})
