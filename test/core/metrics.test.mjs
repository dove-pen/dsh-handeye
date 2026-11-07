import test from 'node:test'
import assert from 'node:assert/strict'

import { computeMetrics, formatMetrics, DEVIATION_CODES, BUDGET_CODES } from '../../src/core/metrics.js'

function goal(overrides = {}) {
  return {
    id: 'goal_20261107_abcdef',
    title: 't',
    status: 'active',
    steps: [],
    runs: [],
    ...overrides,
  }
}

test('empty input gives zeros and a null pass rate (not a fake 0%)', () => {
  const m = computeMetrics()
  assert.equal(m.goals.total, 0)
  assert.equal(m.steps.total, 0)
  assert.equal(m.passRate, null)
  assert.equal(m.deviationRefused, 0)
})

test('counts goals and step statuses', () => {
  const m = computeMetrics({
    goals: [
      goal({
        steps: [
          { id: 's1', status: 'done', attempts: 1 },
          { id: 's2', status: 'doing', attempts: 2 },
          { id: 's3', status: 'blocked', attempts: 2 },
          { id: 's4', status: 'todo' },
          { id: 's5', status: 'skipped', attempts: 1 },
        ],
      }),
      goal({ id: 'goal_20261107_bbbbbb', status: 'paused', steps: [{ id: 's1', status: 'todo' }] }),
    ],
  })
  assert.equal(m.goals.total, 2)
  assert.equal(m.goals.active, 1)
  assert.equal(m.goals.paused, 1)
  assert.equal(m.steps.total, 6)
  assert.equal(m.steps.done, 1)
  assert.equal(m.steps.doing, 1)
  assert.equal(m.steps.blocked, 1)
  assert.equal(m.blockedSteps, 1)
  assert.equal(m.attempts, 6)
})

test('pass rate uses only judged runs', () => {
  const m = computeMetrics({
    goals: [
      goal({
        runs: [
          { verify: 'pass' },
          { verify: 'pass' },
          { verify: 'fail' },
          { verify: 'override' },
          { verify: 'none' },
        ],
      }),
    ],
  })
  assert.equal(m.verify.pass, 2)
  assert.equal(m.verify.fail, 1)
  assert.equal(m.verify.override, 1)
  assert.equal(m.verify.none, 1)
  assert.equal(m.passRate, 0.667)
  assert.equal(m.overrides, 1)
})

test('budget-extension bookkeeping runs do not pollute the numbers', () => {
  const m = computeMetrics({ goals: [goal({ runs: [{ kind: 'budget-extend', extra: 8, stepId: 's1' }] })] })
  assert.equal(m.verify.pass + m.verify.fail, 0)
  assert.equal(m.passRate, null)
})

test('refusals are split into deviation and budget', () => {
  const m = computeMetrics({
    goals: [],
    refusals: {
      GOAL_STEP_REQUIRED: 3,
      STEP_TOOL_NOT_ALLOWED: 2,
      STEP_BUDGET_EXCEEDED: 4,
      PAUSED: 9,
    },
  })
  assert.equal(m.deviationRefused, 5)
  assert.equal(m.budgetRefused, 4)
  assert.equal(m.refusals.PAUSED, 9)
  assert.ok(DEVIATION_CODES.includes('GOAL_STEP_REQUIRED'))
  assert.ok(BUDGET_CODES.includes('STEP_BUDGET_EXCEEDED'))
})

test('formatMetrics renders a readable three-line summary', () => {
  const m = computeMetrics({
    goals: [goal({ steps: [{ id: 's1', status: 'done' }], runs: [{ verify: 'pass' }, { verify: 'fail' }] })],
    refusals: { GOAL_STEP_REQUIRED: 1 },
  })
  const text = formatMetrics(m)
  assert.match(text, /目标 1（进行 1）· 步骤 1\/1/)
  assert.match(text, /验收通过率 50%/)
  assert.match(text, /拦下越界 1/)
})

test('formatMetrics says so when nothing has been judged yet', () => {
  assert.match(formatMetrics(computeMetrics()), /还没验过/)
})
