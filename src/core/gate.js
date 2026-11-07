// The single decision point before any state-changing action.
//
// canAct() answers three questions:
//   1. Is the runtime allowed to act at all (paused / re-plan required)?
//   2. Is this tool allowed for the current task?
//   3. What risk class does the action carry (does it need confirmation)?

import { ERR } from './errors.js'
import { STATES, checkBudget, PATH_ACTION_LIMIT } from './state.js'
import {
  classifyRisk,
  isActionTool,
  isMetaTool,
  isReadTool,
  matchAny,
} from './risk.js'

/**
 * @returns {{ok:boolean, code:string, message?:string, risk?:string}}
 *   ok=false  -> refused (PAUSED / REPLAN_REQUIRED / TOOL_NOT_ALLOWED / BUDGET_EXCEEDED)
 *   ok=true   -> allowed; code is READ, META, or CONFIRM_REQUIRED (caller checks the token)
 */
export function canAct(state, tool, args = {}, now = Date.now()) {
  const name = String(tool)

  // Meta tools and goal tools are how you get back into a legal state, so they
  // are never blocked by the rules below. (goal_* used to be caught by the
  // path-deviation rule, which is absurd: they are the tools that manage paths.)
  if (isMetaTool(name) || name.startsWith('goal_')) return { ok: true, code: 'META' }

  const read = isReadTool(name, args)

  // ---------------------------------------------------------------- goal layer
  //
  // Two rules, both about the step we are on. They are checked before the
  // generic rules because "you are in the wrong place entirely" is the more
  // useful thing to tell a model that is wandering.
  if (state.goalId && !state.currentStep && !read) {
    return {
      ok: false,
      code: ERR.GOAL_STEP_REQUIRED,
      message:
        'A goal is active but no step is entered. Call goal_step_enter first (goal_status lists the steps), so this action belongs to a step.',
    }
  }

  if (state.currentStep) {
    const step = state.currentStep
    if (!read && Array.isArray(step.allowedTools) && step.allowedTools.length > 0 && !matchAny(step.allowedTools, name)) {
      return {
        ok: false,
        code: ERR.STEP_TOOL_NOT_ALLOWED,
        message: `Step "${step.stepId}" only allows: ${step.allowedTools.join(', ')}`,
      }
    }
    const limit = Number(step.budgetActions) || 8
    if (!read && Number(state.stepActions ?? 0) >= limit) {
      return {
        ok: false,
        code: ERR.STEP_BUDGET_EXCEEDED,
        message: `Step "${step.stepId}" has used ${state.stepActions}/${limit} actions. If this step really needs more, call goal_step_continue with a reason; otherwise finish it.`,
      }
    }
  }

  if (state.state === STATES.PAUSED) {
    if (read) return { ok: true, code: 'READ' }
    return { ok: false, code: ERR.PAUSED, message: state.reason || 'Paused' }
  }

  const action = isActionTool(name, args)

  if (state.state === STATES.REPLAN && action) {
    return {
      ok: false,
      code: ERR.REPLAN_REQUIRED,
      message: 'Restate the plan via episode_replan before acting',
    }
  }

  if (action && Array.isArray(state.allowedTools) && !matchAny(state.allowedTools, name)) {
    return {
      ok: false,
      code: ERR.TOOL_NOT_ALLOWED,
      message: `Tool "${name}" is not allowed for this task`,
    }
  }

  if (action) {
    const path = Array.isArray(state.path) ? state.path : []
    if (path.length && state.pathIndex < path.length && state.actionsSinceCheckpoint >= PATH_ACTION_LIMIT) {
      return {
        ok: false,
        code: ERR.PATH_DEVIATION,
        message: `Path step ${state.pathIndex + 1} (${path[state.pathIndex]}) needs an episode_checkpoint before more actions`,
      }
    }
    if (state.state === STATES.RUNNING) {
      const budget = checkBudget(state, now)
      if (!budget.ok) {
        return { ok: false, code: budget.code, message: budget.reason }
      }
    }
  }

  const risk = classifyRisk(name, args)
  if (risk === 'read') return { ok: true, code: 'READ', risk }
  return { ok: true, code: 'CONFIRM_REQUIRED', risk }
}
