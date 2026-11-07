import test from 'node:test'
import assert from 'node:assert/strict'

import { createState, STATES } from '../../src/core/state.js'
import { createMetaTools } from '../../src/tools/meta.js'

function setup(storeOverrides = {}) {
  const state = createState()
  const store = {
    list: async () => ({ ok: true, value: [] }),
    read: async () => ({ ok: false, code: 'NOT_FOUND', message: 'missing' }),
    ...storeOverrides,
  }
  const tools = createMetaTools({ state, episodes: store })
  const byName = (name) => tools.find((t) => t.name === name)
  return { state, store, tools, byName }
}

test('episode_begin enters RUNNING with an id', async () => {
  const { state, byName } = setup()
  const out = await byName('episode_begin').execute({ intent: 'check balance' })
  assert.match(out, /^Episode ep_/)
  assert.equal(state.state, STATES.RUNNING)
  assert.ok(state.episodeId.startsWith('ep_'))
  assert.equal(state.intent, 'check balance')
})

test('episode_begin rejects an empty intent', async () => {
  const { state, byName } = setup()
  const out = await byName('episode_begin').execute({ intent: '   ' })
  assert.match(out, /requires a non-empty intent/)
  assert.equal(state.state, STATES.IDLE)
})

test('episode_replan enforces a non-trivial plan', async () => {
  const { state, byName } = setup()
  state.state = STATES.REPLAN
  state.needsReplan = true

  const short = await byName('episode_replan').execute({ plan: 'continue' })
  assert.match(short, /too short/i)
  assert.equal(state.state, STATES.REPLAN)

  const good = await byName('episode_replan').execute({ plan: 'Only read the balance, do not click top-up, then stop.' })
  assert.match(good, /Plan accepted/)
  assert.equal(state.state, STATES.RUNNING)
})

test('pause_request pauses until the user resumes', async () => {
  const { state, byName } = setup()
  state.state = STATES.RUNNING
  const out = await byName('pause_request').execute({ reason: 'unsure about the button' })
  assert.match(out, /Paused:/)
  assert.equal(state.state, STATES.PAUSED)
})

test('episode_query lists formatted rows', async () => {
  const rows = [
    { id: 'ep_1', startedAt: '2026-11-07T09:00:00+08:00', outcome: 'success', intent: { text: 'check balance' } },
  ]
  const { byName } = setup({ list: async () => ({ ok: true, value: rows }) })
  const out = await byName('episode_query').execute({ action: 'list' })
  assert.match(out, /ep_1/)
  assert.match(out, /check balance/)
})

test('episode_checkpoint advances the path', async () => {
  const { state, byName } = setup()
  state.state = STATES.RUNNING
  state.path = ['first step', 'second step']
  state.pathIndex = 0
  state.actionsSinceCheckpoint = 2

  const out = await byName('episode_checkpoint').execute({ summary: 'did the first step' })
  assert.match(out, /Step 1 done/)
  assert.match(out, /second step/)
  assert.equal(state.pathIndex, 1)
  assert.equal(state.actionsSinceCheckpoint, 0)

  const done = await byName('episode_checkpoint').execute({ summary: 'did the second step' })
  assert.match(done, /Path complete/)
})

test('episode_query shows one episode as JSON', async () => {
  const ep = { id: 'ep_1', steps: [] }
  const { byName } = setup({ read: async () => ({ ok: true, value: ep }) })
  const out = await byName('episode_query').execute({ action: 'show', id: 'ep_1' })
  assert.equal(JSON.parse(out).id, 'ep_1')
})

// --- 验收门：checkpoint 先验后推（v0.8） ---------------------------------

function setupWithVerify(verifyStep) {
  const state = createState()
  const tools = createMetaTools({ state, episodes: { list: async () => ({ ok: true, value: [] }) }, verifyStep })
  return { state, tool: tools.find((t) => t.name === 'episode_checkpoint') }
}

test('episode_checkpoint advances when the acceptance check passes', async () => {
  const { state, tool } = setupWithVerify(async () => ({ ok: true, checks: [] }))
  state.path = ['第一步', '第二步']
  state.pathIndex = 0
  const out = await tool.execute({ summary: '做完了' })
  assert.match(out, /Step 1 done/)
  assert.equal(state.pathIndex, 1)
})

test('episode_checkpoint refuses to advance when the check fails', async () => {
  const { state, tool } = setupWithVerify(async () => ({
    ok: false,
    checks: [{ type: 'file', target: '文件 D:\\a.md', ok: false, expected: '存在', actual: '文件不存在' }],
  }))
  state.path = ['第一步', '第二步']
  state.pathIndex = 0
  const out = await tool.execute({ summary: '做完了' })
  assert.match(out, /失败：这一步的验收没过/)
  assert.match(out, /文件不存在/)
  assert.equal(state.pathIndex, 0, 'path must not move')
  assert.equal(state.verifyFailures, 1)
})

test('episode_checkpoint escalates the hint after the second failure', async () => {
  const { state, tool } = setupWithVerify(async () => ({
    ok: false,
    checks: [{ type: 'exit', target: '命令 node --test', ok: false, expected: '退出码 0', actual: '退出码 1' }],
  }))
  state.path = ['一步']
  await tool.execute({ summary: 'x' })
  const out = await tool.execute({ summary: 'x' })
  assert.match(out, /第 2 次没过/)
  assert.equal(state.verifyFailures, 2)
})

test('episode_checkpoint stays on the old behaviour when there is no verifier', async () => {
  const state = createState()
  const tools = createMetaTools({ state, episodes: { list: async () => ({ ok: true, value: [] }) } })
  const tool = tools.find((t) => t.name === 'episode_checkpoint')
  state.path = ['一步']
  const out = await tool.execute({ summary: '做完了' })
  assert.match(out, /Path complete/)
  assert.equal(state.pathIndex, 1)
})

test('episode_begin accepts cardId and hands it to onBegin', async () => {
  const state = createState()
  const seen = []
  const tools = createMetaTools({ state, episodes: { list: async () => ({ ok: true, value: [] }) }, onBegin: (i) => seen.push(i) })
  const begin = tools.find((t) => t.name === 'episode_begin')
  const out = await begin.execute({ intent: '写个文档', cardId: 'write_doc' })
  assert.match(out, /write_doc/)
  assert.equal(state.cardId, 'write_doc')
  assert.equal(seen[0].cardId, 'write_doc')
})