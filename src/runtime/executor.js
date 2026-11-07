// Capability executor.
//
// Deliberately thin: it orchestrates validation, the gate, confirmation,
// preconditions, the op loop and postconditions. Every side effect lives in the
// injected `ops` object, so the whole module is testable with fakes.

import { canAct } from '../core/gate.js'
import { ERR, failure, success } from '../core/errors.js'
import { noteAction } from '../core/state.js'
import { applyParams } from '../memory/schema.js'

const MAX_TRACE_DETAIL = 400

/** Resolve ${name} references inside a step's strings. */
export function substitute(value, vars, depth = 0) {
  if (depth > 5) return value
  if (typeof value === 'string') {
    return value.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
    )
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, vars, depth + 1)
    return out
  }
  return value
}

function assumptionsOf(schema, supplied) {
  const out = {}
  for (const [key, spec] of Object.entries(schema ?? {})) {
    if (spec?.default !== undefined && (supplied === undefined || !(key in (supplied ?? {})))) {
      out[key] = spec.default
    }
  }
  return out
}

function brief(value) {
  const text = String(value ?? '')
  return text.length > MAX_TRACE_DETAIL ? `${text.slice(0, MAX_TRACE_DETAIL)}…` : text
}

/**
 * @param {object} deps
 * @param {object} deps.state runtime state (state.js)
 * @param {{run:Function, checkPrecondition?:Function, checkPostcondition?:Function}} deps.ops
 * @param {{consume:Function}} [deps.confirm]
 */
export function createExecutor({ state, ops, confirm, clock = () => Date.now() } = {}) {
  if (!state) throw new TypeError('createExecutor requires state')
  if (!ops || typeof ops.run !== 'function') throw new TypeError('createExecutor requires ops.run')

  async function run(cap, params = {}, { token } = {}) {
    if (!cap || typeof cap !== 'object' || !Array.isArray(cap.steps) || cap.steps.length === 0) {
      return failure(ERR.CAPABILITY_INVALID, 'Capability has no steps')
    }
    if (cap.status !== 'enabled') {
      return failure(ERR.CAPABILITY_INVALID, `Capability "${cap.name}" is ${cap.status ?? 'not enabled'}`)
    }

    const risk = cap.risk === 'destructive' ? 'destructive' : cap.risk === 'write' ? 'write' : 'read'
    const gate = canAct(state, 'capability', { action: 'run', risk }, clock())
    if (!gate.ok) return failure(gate.code, gate.message)

    if (risk !== 'read') {
      const grant = confirm?.consume?.(token, risk)
      if (!grant || grant.ok !== true) {
        return {
          ok: false,
          code: ERR.CONFIRM_REQUIRED,
          message: grant?.message || `Confirmation required for a ${risk} capability`,
          details: { risk },
        }
      }
    }

    const applied = applyParams(cap.params ?? {}, params)
    if (!applied.ok) return failure(ERR.PARAMS_INVALID, 'Invalid capability parameters', applied.errors)
    const vars = { ...applied.values }

    for (const pre of cap.preconditions ?? []) {
      const result = ops.checkPrecondition ? await ops.checkPrecondition(pre) : { ok: true }
      if (!result || result.ok !== true) {
        return failure(ERR.PRECONDITION_FAILED, result?.message || 'Precondition failed', { check: pre })
      }
    }

    const trace = []
    for (let i = 0; i < cap.steps.length; i += 1) {
      const stepGate = canAct(state, 'capability', { action: 'run', risk }, clock())
      if (!stepGate.ok) {
        return failure(stepGate.code, stepGate.message, { step: i, trace })
      }

      const step = substitute(cap.steps[i], vars)
      let result
      const started = clock()
      try {
        result = await ops.run(step, { vars, timeoutMs: step.timeoutMs })
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      const ok = result?.ok === true
      const ended = clock()
      const entry = {
        index: i,
        op: step.op,
        ok,
        ms: Number.isFinite(result?.ms) ? result.ms : ended - started,
        brief: brief(result?.brief ?? result?.message ?? ''),
      }
      trace.push(entry)

      const trip = noteAction(state, 'capability', { action: 'run', step: step.op }, ok)
      if (!ok) {
        return failure(ERR.STEP_FAILED, `Step ${i + 1} (${step.op}) failed: ${result?.message ?? 'unknown error'}`, {
          step: i,
          op: step.op,
          expected: step.expect,
          actual: result?.actual,
          screenshot: result?.screenshot,
          trace,
        })
      }
      if (trip.tripped) {
        return failure(ERR.PAUSED, trip.reason, { step: i, trace })
      }
      if (result?.vars && typeof result.vars === 'object') Object.assign(vars, result.vars)
    }

    for (const post of cap.postconditions ?? []) {
      const result = ops.checkPostcondition ? await ops.checkPostcondition(post, vars) : { ok: true }
      if (!result || result.ok !== true) {
        return failure(ERR.POSTCONDITION_FAILED, result?.message || 'Postcondition failed', { assert: post, trace })
      }
    }

    const outputs = {}
    for (const key of cap.outputs ?? []) {
      if (Object.prototype.hasOwnProperty.call(vars, key)) outputs[key] = vars[key]
    }

    return success(outputs, {
      trace,
      assumptions: assumptionsOf(cap.params, params),
    })
  }

  return { run }
}
