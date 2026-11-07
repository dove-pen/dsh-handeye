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
