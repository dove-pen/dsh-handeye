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

  if (isMetaTool(name)) return { ok: true, code: 'META' }

  const read = isReadTool(name, args)

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
