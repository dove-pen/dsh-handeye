// Runtime state machine for one task episode.
//
// Pure module: no I/O, no timers, no globals. All transitions take the state
// object and return it, so tests can drive every edge without a harness.

import { ERR } from './errors.js'

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  REPLAN: 'REPLAN_REQUIRED',
})

const MIN_REPLAN_CHARS = 12
const REPEAT_LIMIT = 3
const FAILURE_LIMIT = 3

export function createState(opts = {}) {
  return {
    state: STATES.IDLE,
    reason: '',
    needsReplan: false,
    replanPlan: '',
    episodeId: '',
    intent: '',
    allowedTools: null,
    budget: {
      steps: 0,
      maxSteps: opts.maxSteps ?? 25,
      startedAt: 0,
      maxMs: opts.maxMs ?? 5 * 60 * 1000,
    },
    recent: [],
    failures: 0,
  }
}

function resetBudget(state) {
  state.budget.steps = 0
  state.budget.startedAt = Date.now()
  state.recent = []
  state.failures = 0
}

export function beginEpisode(state, intent, opts = {}) {
  state.state = STATES.RUNNING
  state.reason = ''
  state.needsReplan = false
  state.replanPlan = ''
  state.intent = String(intent ?? '')
  state.episodeId = String(opts.episodeId ?? '')
  state.allowedTools = Array.isArray(opts.allowedTools) ? [...opts.allowedTools] : null
  resetBudget(state)
  return state
}

export function endEpisode(state, reason = '') {
  state.state = STATES.IDLE
  state.reason = String(reason ?? '')
  state.needsReplan = false
  state.replanPlan = ''
  state.allowedTools = null
  return state
}

export function pause(state, reason = 'Paused') {
  state.state = STATES.PAUSED
  state.reason = String(reason || 'Paused')
  return state
}

/** User pressed resume: continue only after the model restates its plan. */
export function resumeByUser(state) {
  if (state.state !== STATES.PAUSED) return state
  state.state = STATES.REPLAN
  state.needsReplan = true
  state.replanPlan = ''
  state.reason = 'Resumed by user; restate the plan before acting'
  return state
}

/** Constraint-bearing interjection: stop the current action and re-plan. */
export function interjectConstraint(state, reason = '') {
  if (state.state === STATES.PAUSED) {
    state.reason = String(reason || state.reason)
    return state
  }
  state.state = STATES.REPLAN
  state.needsReplan = true
  state.replanPlan = ''
  state.reason = String(reason || 'Constraint received from the user')
  return state
}

export function satisfyReplan(state, plan) {
  if (state.state !== STATES.REPLAN) return state
  const text = String(plan ?? '').trim()
  if (text.length < MIN_REPLAN_CHARS) return state
  state.replanPlan = text
  state.needsReplan = false
  state.state = STATES.RUNNING
  state.reason = ''
  return state
}

export function fingerprint(tool, args) {
  let body = ''
  try {
    body = JSON.stringify(args ?? {})
  } catch {
    body = String(args)
  }
  return `${tool}|${body}`
}

/**
 * Record one action. Returns { tripped, reason } when a loop/failure guard
 * just paused the runtime, so callers can report the same reason.
 */
export function noteAction(state, tool, args, ok = true) {
  state.budget.steps += 1
  state.recent.push(fingerprint(tool, args))
  if (state.recent.length > REPEAT_LIMIT + 3) state.recent.shift()
  state.failures = ok ? 0 : state.failures + 1

  const r = state.recent
  if (r.length >= REPEAT_LIMIT) {
    const tail = r.slice(-REPEAT_LIMIT)
    if (tail.every((x) => x === tail[0])) {
      pause(state, 'Same action repeated 3 times; possible loop')
      return { tripped: true, reason: state.reason }
    }
  }
  if (r.length >= 4) {
    const [a, b, c, d] = r.slice(-4)
    if (a === c && b === d && a !== b) {
      pause(state, 'Alternating loop detected (A/B/A/B)')
      return { tripped: true, reason: state.reason }
    }
  }
  if (state.failures >= FAILURE_LIMIT) {
    pause(state, '3 consecutive action failures')
    return { tripped: true, reason: state.reason }
  }
  return { tripped: false, reason: '' }
}

export function checkBudget(state, now = Date.now()) {
  if (state.budget.steps >= state.budget.maxSteps) {
    pause(state, `Step budget exceeded (${state.budget.maxSteps})`)
    return { ok: false, code: ERR.BUDGET_EXCEEDED, reason: state.reason }
  }
  if (state.budget.startedAt && now - state.budget.startedAt > state.budget.maxMs) {
    pause(state, 'Time budget exceeded')
    return { ok: false, code: ERR.BUDGET_EXCEEDED, reason: state.reason }
  }
  return { ok: true, code: 'OK', reason: '' }
}

export function isRunning(state) {
  return state.state === STATES.RUNNING
}

export function isPaused(state) {
  return state.state === STATES.PAUSED
}
