// Stable error codes shared by every module.
//
// Rules:
//   - Business failures are returned as { ok: false, code, message, details }.
//   - `throw` is reserved for programmer errors (broken invariants).
//   - Messages are English; the UI maps codes/messages to the user's language.

export const ERR = Object.freeze({
  PAUSED: 'PAUSED',
  REPLAN_REQUIRED: 'REPLAN_REQUIRED',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  PATH_DEVIATION: 'PATH_DEVIATION',
  CAPABILITY_INVALID: 'CAPABILITY_INVALID',
  CARD_INVALID: 'CARD_INVALID',
  PARAMS_INVALID: 'PARAMS_INVALID',
  STEP_FAILED: 'STEP_FAILED',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  POSTCONDITION_FAILED: 'POSTCONDITION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
})

export function failure(code, message, details) {
  const out = { ok: false, code: String(code), message: String(message) }
  if (details !== undefined) out.details = details
  return out
}

export function success(value, extra = {}) {
  return { ok: true, value, ...extra }
}
