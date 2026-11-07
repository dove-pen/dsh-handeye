import test from 'node:test'
import assert from 'node:assert/strict'

import { canAct } from '../../src/core/gate.js'
import { beginEpisode, createState, pause, STATES, beginGoalStep, endGoalStep, countStepAction, grantStepBudget } from '../../src/core/state.js'
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
  assert.equal(write.code, 'WRITE')
  assert.equal(write.risk, 'write')
  assert.equal(write.ok, true)

  // 破坏性动作必须真的被拦下，等用户点"允许一次"（以前这里返回 ok:true，等于没拦）
  const destructive = canAct(state, 'hand_type', { text: '删除整个文件夹' })
  assert.equal(destructive.risk, 'destructive')
  assert.equal(destructive.ok, false)
  assert.equal(destructive.code, ERR.CONFIRM_REQUIRED)
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

// --- 目标层：步骤门与步骤预算（v0.9） -------------------------------------

test('a running goal refuses actions until a step is entered', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  state.goalId = 'goal_20261107_abcdef'
  const verdict = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, ERR.GOAL_STEP_REQUIRED)
  assert.match(verdict.message, /goal_step_enter/)
})

test('read-only and goal_* tools still work with no step entered', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  state.goalId = 'goal_20261107_abcdef'
  assert.equal(canAct(state, 'desk_windows', {}).ok, true)
  assert.equal(canAct(state, 'goal_status', {}).ok, true)
})

test('a step whitelist narrows what is allowed', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  state.goalId = 'goal_20261107_abcdef'
  state.currentStep = { stepId: 's1', allowedTools: ['browser_*'], budgetActions: 8 }
  assert.equal(canAct(state, 'browser_open', {}).ok, true)
  const denied = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, ERR.STEP_TOOL_NOT_ALLOWED)
  assert.match(denied.message, /browser_\*/)
})

test('the step budget refuses more actions and points at goal_step_continue', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  state.goalId = 'goal_20261107_abcdef'
  state.currentStep = { stepId: 's1', allowedTools: null, budgetActions: 2 }
  state.stepActions = 2
  const verdict = canAct(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, ERR.STEP_BUDGET_EXCEEDED)
  assert.match(verdict.message, /goal_step_continue/)
  // reads are still fine while out of budget
  assert.equal(canAct(state, 'desk_windows', {}).ok, true)
})

test('grantStepBudget raises the limit for the current step only', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  state.currentStep = { stepId: 's1', allowedTools: null, budgetActions: 2 }
  state.stepActions = 2
  assert.equal(grantStepBudget(state, 5), 7)
  assert.equal(canAct(state, 'hand_click', { x: 1, y: 2 }).ok, true)
  endGoalStep(state)
  assert.equal(state.currentStep, null)
  assert.equal(state.stepActions, 0)
})

test('countStepAction tracks per-step usage and flags the budget', () => {
  const state = createState()
  beginEpisode(state, 'goal work')
  beginGoalStep(state, { goalId: 'g', step: { id: 's1', title: 'x', budget: { actions: 2 } } })
  assert.deepEqual(countStepAction(state), { tracked: true, used: 1, limit: 2, overBudget: false })
  assert.deepEqual(countStepAction(state), { tracked: true, used: 2, limit: 2, overBudget: true })
  endGoalStep(state)
  assert.equal(countStepAction(state).tracked, false)
})