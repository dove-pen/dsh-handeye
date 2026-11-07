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
export const PATH_ACTION_LIMIT = 3

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
    path: [],
    pathIndex: 0,
    actionsSinceCheckpoint: 0,
    // Which card this episode came from, and the acceptance rules it carries.
    // verifyStep() reads these; null means "this episode has no acceptance
    // rules", which is the old behaviour (checkpoint just advances).
    cardId: '',
    verifyChecks: null,
    verifyVars: {},
    // How many times the acceptance check refused to advance this episode.
    verifyFailures: 0,
    // Goal layer: when a goal step is entered, actions are bound to it.
    goalId: '',
    currentStep: null,
    stepActions: 0,
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
  state.path = Array.isArray(opts.path) ? opts.path.map((step) => String(step)).filter(Boolean).slice(0, 12) : []
  state.pathIndex = 0
  state.actionsSinceCheckpoint = 0
  state.cardId = String(opts.cardId ?? '')
  state.verifyChecks = Array.isArray(opts.verify) && opts.verify.length > 0 ? opts.verify : null
  state.verifyVars = opts.params && typeof opts.params === 'object' ? { ...opts.params } : {}
  state.verifyFailures = 0
  resetBudget(state)
  return state
}

export function endEpisode(state, reason = '') {
  state.state = STATES.IDLE
  state.reason = String(reason ?? '')
  state.needsReplan = false
  state.replanPlan = ''
  state.allowedTools = null
  state.path = []
  state.pathIndex = 0
  state.actionsSinceCheckpoint = 0
  state.cardId = ''
  state.verifyChecks = null
  state.verifyVars = {}
  state.verifyFailures = 0
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
  if (Array.isArray(state.path) && state.path.length && state.pathIndex < state.path.length) {
    state.actionsSinceCheckpoint += 1
  }
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

/** Advance one declared path step. Called by the episode_checkpoint tool. */
export function checkpoint(state, summary = '') {
  if (!Array.isArray(state.path) || state.path.length === 0) {
    return { ok: false, message: 'No path is active for this episode' }
  }
  if (state.pathIndex >= state.path.length) {
    return { ok: false, message: 'Path is already complete' }
  }
  state.pathIndex += 1
  state.actionsSinceCheckpoint = 0
  const done = state.pathIndex >= state.path.length
  return {
    ok: true,
    done,
    index: state.pathIndex,
    next: done ? null : state.path[state.pathIndex],
    summary: String(summary ?? ''),
  }
}

export function isPaused(state) {
  return state.state === STATES.PAUSED
}

// ---------------------------------------------------------------- goal steps
//
// A goal step is a stricter episode: same state machine, but the gate now knows
// which step we are on, so it can refuse actions that belong to no step at all.

export function beginGoalStep(state, { goalId, step, verified = null, params = {} } = {}) {
  state.goalId = String(goalId ?? '')
  state.currentStep = {
    goalId: state.goalId,
    stepId: String(step?.id ?? ''),
    title: String(step?.title ?? ''),
    promptId: step?.promptId ?? null,
    allowedTools: Array.isArray(step?.allowedTools) ? [...step.allowedTools] : null,
    budgetActions: Number(step?.budget?.actions) > 0 ? Number(step.budget.actions) : 8,
  }
  state.stepActions = 0
  if (Array.isArray(verified) && verified.length > 0) {
    state.verifyChecks = verified
    state.verifyVars = params && typeof params === 'object' ? { ...params } : {}
  }
  return state
}

export function endGoalStep(state) {
  state.currentStep = null
  state.stepActions = 0
  return state
}

/** Called after every action while a goal step is running. */
export function countStepAction(state) {
  if (!state.currentStep) return { tracked: false, used: 0, limit: 0, overBudget: false }
  state.stepActions = Number(state.stepActions ?? 0) + 1
  const limit = Number(state.currentStep.budgetActions) || 8
  return { tracked: true, used: state.stepActions, limit, overBudget: state.stepActions >= limit }
}

/** Soft budget: the user (or an explicit continue) grants more actions. */
export function grantStepBudget(state, extra = 8) {
  if (!state.currentStep) return 0
  const add = Math.max(1, Math.min(40, Math.round(Number(extra) || 8)))
  state.currentStep.budgetActions = Number(state.currentStep.budgetActions || 0) + add
  return state.currentStep.budgetActions
}
