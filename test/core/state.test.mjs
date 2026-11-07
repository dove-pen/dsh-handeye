import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STATES,
  beginEpisode,
  checkBudget,
  createState,
  endEpisode,
  interjectConstraint,
  noteAction,
  pause,
  resumeByUser,
  satisfyReplan,
} from '../../src/core/state.js'

test('beginEpisode enters RUNNING and resets the budget', () => {
  const state = createState({ maxSteps: 10 })
  beginEpisode(state, 'check balance', { allowedTools: ['browser_*'] })
  assert.equal(state.state, STATES.RUNNING)
  assert.equal(state.intent, 'check balance')
  assert.deepEqual(state.allowedTools, ['browser_*'])
  assert.equal(state.budget.steps, 0)
  assert.ok(state.budget.startedAt > 0)
})

test('endEpisode returns to IDLE and clears the allow-list', () => {
  const state = createState()
  beginEpisode(state, 'x', { allowedTools: ['browser_*'] })
  endEpisode(state, 'done')
  assert.equal(state.state, STATES.IDLE)
  assert.equal(state.allowedTools, null)
})

test('pause blocks, resume requires a re-plan', () => {
  const state = createState()
  beginEpisode(state, 'x')
  pause(state, 'manual')
  assert.equal(state.state, STATES.PAUSED)

  resumeByUser(state)
  assert.equal(state.state, STATES.REPLAN)
  assert.equal(state.needsReplan, true)

  satisfyReplan(state, 'too short')
  assert.equal(state.state, STATES.REPLAN, 'short plans are rejected')

  satisfyReplan(state, 'I will only read the balance and stop')
  assert.equal(state.state, STATES.RUNNING)
  assert.equal(state.needsReplan, false)
})

test('a constraint interjection forces a re-plan', () => {
  const state = createState()
  beginEpisode(state, 'x')
  interjectConstraint(state, 'only read')
  assert.equal(state.state, STATES.REPLAN)
  assert.equal(state.needsReplan, true)
})

test('three identical actions pause the runtime', () => {
  const state = createState()
  beginEpisode(state, 'x')
  noteAction(state, 'hand_click', { x: 1, y: 2 })
  noteAction(state, 'hand_click', { x: 1, y: 2 })
  const third = noteAction(state, 'hand_click', { x: 1, y: 2 })
  assert.equal(third.tripped, true)
  assert.equal(state.state, STATES.PAUSED)
})

test('an A/B alternation pauses the runtime', () => {
  const state = createState()
  beginEpisode(state, 'x')
  noteAction(state, 'hand_click', { x: 1 })
  noteAction(state, 'hand_click', { x: 2 })
  noteAction(state, 'hand_click', { x: 1 })
  const fourth = noteAction(state, 'hand_click', { x: 2 })
  assert.equal(fourth.tripped, true)
  assert.equal(state.state, STATES.PAUSED)
})

test('three consecutive failures pause the runtime', () => {
  const state = createState()
  beginEpisode(state, 'x')
  noteAction(state, 'hand_click', { x: 1 }, false)
  noteAction(state, 'hand_click', { x: 2 }, false)
  const third = noteAction(state, 'hand_click', { x: 3 }, false)
  assert.equal(third.tripped, true)
  assert.equal(state.state, STATES.PAUSED)
})

test('the step budget pauses the runtime', () => {
  const state = createState({ maxSteps: 2 })
  beginEpisode(state, 'x')
  noteAction(state, 'hand_click', { x: 1 })
  noteAction(state, 'hand_click', { x: 2 })
  const budget = checkBudget(state)
  assert.equal(budget.ok, false)
  assert.equal(state.state, STATES.PAUSED)
})

test('the time budget pauses the runtime', () => {
  const state = createState({ maxMs: 1000 })
  beginEpisode(state, 'x')
  state.budget.startedAt = Date.now() - 5000
  const budget = checkBudget(state)
  assert.equal(budget.ok, false)
  assert.equal(state.state, STATES.PAUSED)
})
