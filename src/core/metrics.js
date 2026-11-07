// Metrics: turn the goal/step/verify records into the three numbers that say
// whether any of this is working.
//
// Deliberately a pure function over plain data: the route hands it the goal
// docs and the gate's refusal counters, nothing else. That keeps it testable
// without a filesystem, and makes "what counts as a deviation" an explicit
// decision instead of an accident.

/** Refusal codes that count as "AI tried to act outside a step". */
export const DEVIATION_CODES = ['GOAL_STEP_REQUIRED', 'STEP_TOOL_NOT_ALLOWED']
/** Refusal codes that count as "the step ran out of its action budget". */
export const BUDGET_CODES = ['STEP_BUDGET_EXCEEDED']

function bump(map, key, by = 1) {
  if (!key) return
  map[key] = (map[key] || 0) + by
}

/**
 * @param {{goals?:object[], refusals?:Record<string,number>}} input
 * @returns {object} metrics payload
 */
export function computeMetrics({ goals = [], refusals = {} } = {}) {
  const statusCount = {}
  const stepCount = { total: 0, done: 0, doing: 0, blocked: 0, todo: 0, skipped: 0 }
  const verifyCount = { pass: 0, fail: 0, none: 0, override: 0 }
  let overrideRuns = 0
  let blockedSteps = 0
  let attempts = 0

  for (const goal of Array.isArray(goals) ? goals : []) {
    bump(statusCount, goal.status)
    for (const step of Array.isArray(goal.steps) ? goal.steps : []) {
      stepCount.total += 1
      if (stepCount[step.status] !== undefined) stepCount[step.status] += 1
      if (step.status === 'blocked') blockedSteps += 1
      attempts += Number(step.attempts) || 0
    }
    for (const run of Array.isArray(goal.runs) ? goal.runs : []) {
      if (!run || !run.verify) continue
      if (verifyCount[run.verify] !== undefined) verifyCount[run.verify] += 1
      if (run.verify === 'override') overrideRuns += 1
      // A budget-extension run is bookkeeping, not a finished attempt
      if (run.kind === 'budget-extend') continue
    }
  }

  const judged = verifyCount.pass + verifyCount.fail
  const passRate = judged > 0 ? Math.round((verifyCount.pass / judged) * 1000) / 1000 : null

  let deviationRefused = 0
  let budgetRefused = 0
  for (const [code, count] of Object.entries(refusals || {})) {
    const n = Number(count) || 0
    if (DEVIATION_CODES.includes(code)) deviationRefused += n
    if (BUDGET_CODES.includes(code)) budgetRefused += n
  }

  return {
    goals: {
      total: Array.isArray(goals) ? goals.length : 0,
      active: statusCount.active || 0,
      paused: statusCount.paused || 0,
      done: statusCount.done || 0,
      archived: statusCount.archived || 0,
    },
    steps: stepCount,
    verify: verifyCount,
    // null means "nothing has been judged yet" - better than a fake 0%.
    passRate,
    overrides: overrideRuns,
    blockedSteps,
    deviationRefused,
    budgetRefused,
    attempts,
    refusals: { ...(refusals || {}) },
  }
}

/** One-line human summary, used in CLI output and the panel header. */
export function formatMetrics(m) {
  const rate = m.passRate === null ? '还没验过' : `${Math.round(m.passRate * 100)}%`
  return [
    `目标 ${m.goals.total}（进行 ${m.goals.active}）· 步骤 ${m.steps.done}/${m.steps.total}`,
    `验收通过率 ${rate}（过 ${m.verify.pass} / 挂 ${m.verify.fail}）`,
    `拦下越界 ${m.deviationRefused} · 预算拦截 ${m.budgetRefused} · 人工放行 ${m.overrides} · 卡住 ${m.blockedSteps}`,
  ].join('\n')
}
