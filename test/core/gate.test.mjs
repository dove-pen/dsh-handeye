import test from 'node:test'
import assert from 'node:assert/strict'

import { canAct } from '../../src/core/gate.js'
import { beginEpisode, createState, pause, STATES } from '../../src/core/state.js'
import { ERR } from '../../src/core/errors.js'

function stateIn(phase) {
  const state = createState()
  beginEpisode(state, 'test')
  if (phase === STATES.PAUSED) pause(state, 'manual')
  if (phase === STATES.REPLAN) {
    state.state = STATES.REPLAN
    state.needsReplan = true
  }
  return state
}

test('meta tools are allowed even when paused', () => {
  const state = stateIn(STATES.PAUSED)
  assert.equal(canAct(state, 'episode_replan', {}).ok, true)
  assert.equal(canAct(state, 'episode_begin', {}).ok, true)
})

test('reads are allowed while paused, actions are refused', () => {
  const state = stateIn(STATES.PAUSED)
  assert.equal(canAct(state, 'eye_see', { level: 'L0' }).code, 'READ')
  const refused = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ERR.PAUSED)
})

test('actions are refused during REPLAN_REQUIRED, reads still work', () => {
  const state = stateIn(STATES.REPLAN)
  assert.equal(canAct(state, 'desk_windows', {}).code, 'READ')
  const refused = canAct(state, 'hand_type', { text: 'hi' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ERR.REPLAN_REQUIRED)
})

test('allowedTools filters actions but not reads', () => {
  const state = stateIn(STATES.RUNNING)
  state.allowedTools = ['browser_*', 'eye_*']
  assert.equal(canAct(state, 'browser_open', { url: 'https://example.com' }).ok, true)
  assert.equal(canAct(state, 'eye_see', {}).ok, true)
  const refused = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ERR.TOOL_NOT_ALLOWED)
})

test('risk classification reaches the gate', () => {
  const state = stateIn(STATES.RUNNING)
  const read = canAct(state, 'eye_see', {})
  assert.equal(read.code, 'READ')
  assert.equal(read.risk, 'read')

  const write = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(write.code, 'CONFIRM_REQUIRED')
  assert.equal(write.risk, 'write')

  const destructive = canAct(state, 'hand_type', { text: '删除整个文件夹' })
  assert.equal(destructive.risk, 'destructive')
})

test('path deviation refuses actions until a checkpoint', () => {
  const state = stateIn(STATES.RUNNING)
  state.path = ['find the page', 'read the value']
  state.pathIndex = 0
  state.actionsSinceCheckpoint = 3
  const refused = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ERR.PATH_DEVIATION)
  assert.equal(canAct(state, 'eye_see', {}).ok, true, 'reads are still allowed')
})

test('budget exhaustion refuses actions', () => {
  const state = stateIn(STATES.RUNNING)
  state.budget.maxSteps = 1
  state.budget.steps = 1
  const refused = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ERR.BUDGET_EXCEEDED)
  assert.equal(state.state, STATES.PAUSED)
})
