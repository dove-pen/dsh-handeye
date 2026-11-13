// 教程层：用户手写的步骤 + 判据 → 编译成目标 → 跑完回写Health。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createTutorialTools, stepsFromTutorial } from '../../src/tools/tutorials.js'
import { createGoalTools } from '../../src/tools/goals.js'
import { createGoalStore } from '../../src/memory/goals.js'
import { createCardStore } from '../../src/memory/cards.js'
import { createState, beginEpisode } from '../../src/core/state.js'

function tutorialCard(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'tut_invoice',
    title: '整理发票',
    origin: 'user',
    version: 1,
    delivery: 'start',
    autonomy: 'supervised',
    goal: '把一批发票按月份归档，并核对合计',
    constraints: ['只处理 PDF'],
    success: '每个 PDF 都在对应月份目录里',
    path: ['列出所有 PDF', '按月份归档', '核对张数与合计'],
    verify: [{ type: 'file', path: 'out', minBytes: 1 }],
    health: undefined,
    enabled: true,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  }
}

async function setup({ verifyStep } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tutorial-'))
  const goals = createGoalStore({ dir })
  const cards = createCardStore({ dir })
  const state = createState()
  beginEpisode(state, 'tutorial')

  const goalTools = createGoalTools({
    state,
    goals,
    skills: null,
    cards,
    verifyStep,
    prepareStepChecks: async ({ step }) => {
      state.verifyChecks = Array.isArray(step.verify) && step.verify.length ? step.verify : null
      return { checks: state.verifyChecks ? state.verifyChecks.length : 0 }
    },
    onStepEnter: async ({ goal, step }) => {
      state.goalId = goal.id
      state.currentStep = { stepId: step.id, allowedTools: null, budgetActions: 8 }
      return { episodeId: 'ep_test', checks: 0 }
    },
    onStepLeave: async () => {
      state.currentStep = null
    },
  })
  const tutorialTools = createTutorialTools({ state, cards, goals })
  return { dir, goals, cards, state, by: (n) => [...goalTools, ...tutorialTools].find((t) => t.name === n), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 纯函数

test('tutorial path becomes goal steps, with checks on the last step only', () => {
  const { steps, missing } = stepsFromTutorial(tutorialCard())
  assert.deepEqual(missing, [])
  assert.equal(steps.length, 3)
  assert.equal(steps[0].title, '列出所有 PDF')
  assert.equal(steps[0].verify, null, '判据不能挂在中间步骤上')
  assert.deepEqual(steps[2].verify, [{ type: 'file', path: 'out', minBytes: 1 }])
})

test('a tutorial without checks is still usable, just unverified', () => {
  const { steps } = stepsFromTutorial(tutorialCard({ verify: undefined }))
  assert.equal(steps.length, 3)
  assert.equal(steps[2].verify, null)
})

// ---------------------------------------------------------------- 读写

test('tutorial_list shows steps, checks and health', async () => {
  const s = await setup()
  try {
    await s.cards.saveUser(tutorialCard())
    const out = await s.by('tutorial_list').execute({})
    assert.match(out, /tut_invoice/)
    assert.match(out, /3 steps/)
    assert.match(out, /1 checks/)
  } finally {
    await s.cleanup()
  }
})

test('tutorial_get returns the whole procedure', async () => {
  const s = await setup()
  try {
    await s.cards.saveUser(tutorialCard())
    const out = await s.by('tutorial_get').execute({ tutorialId: 'tut_invoice' })
    assert.match(out, /# 整理发票/)
    assert.match(out, /1\. 列出所有 PDF/)
    assert.match(out, /Constraints/)
    assert.match(out, /只处理 PDF/)
    assert.match(out, /Acceptance checks/)
  } finally {
    await s.cleanup()
  }
})

// ---------------------------------------------------------------- 执行

test('tutorial_start compiles the tutorial into a focused goal', async () => {
  const s = await setup()
  try {
    await s.cards.saveUser(tutorialCard())
    const out = await s.by('tutorial_start').execute({ tutorialId: 'tut_invoice' })
    assert.match(out, /created from tutorial/)

    const goal = (await s.goals.list()).value[0]
    assert.equal(goal.title, '整理发票')
    assert.equal(goal.longTermGoal, '把一批发票按月份归档，并核对合计')
    assert.equal(goal.steps.length, 3)
    assert.equal(goal.meta.tutorialId, 'tut_invoice')
    assert.deepEqual(goal.steps[2].verify, [{ type: 'file', path: 'out', minBytes: 1 }])
    assert.equal(s.state.goalId, goal.id, '建目标即聚焦')
  } finally {
    await s.cleanup()
  }
})

test('tutorial_start refuses a missing required param', async () => {
  const s = await setup()
  try {
    await s.cards.saveUser(
      tutorialCard({ params: { folder: { type: 'string', required: true, description: '目录' } }, path: ['打开 {{folder}}', '归档'] }),
    )
    const out = await s.by('tutorial_start').execute({ tutorialId: 'tut_invoice' })
    assert.match(out, /Missing params/)
    assert.match(out, /folder/)
    assert.equal((await s.goals.list()).value.length, 0, 'Missing params不许建目标')
  } finally {
    await s.cleanup()
  }
})

test('tutorial_start refuses a disabled tutorial', async () => {
  const s = await setup()
  try {
    await s.cards.saveUser(tutorialCard({ enabled: false }))
    const out = await s.by('tutorial_start').execute({ tutorialId: 'tut_invoice' })
    assert.match(out, /disabled/)
  } finally {
    await s.cleanup()
  }
})

// ---------------------------------------------------------------- Health闭环

test('finishing every step records a success on the tutorial', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    await s.cards.saveUser(tutorialCard())
    await s.by('tutorial_start').execute({ tutorialId: 'tut_invoice' })
    const goal = (await s.goals.list()).value[0]
    for (const id of ['s1', 's2', 's3']) {
      await s.by('goal_step_enter').execute({ goalId: goal.id, stepId: id })
      await s.by('goal_step_done').execute({ goalId: goal.id, stepId: id, summary: '做了 ' + id })
    }
    const card = await s.cards.get('tut_invoice')
    assert.equal(card.value.health.runs, 1)
    assert.equal(card.value.health.ok, 1)
    assert.equal(card.value.health.status, 'healthy')
  } finally {
    await s.cleanup()
  }
})

test('a blocked step records a failure on the tutorial', async () => {
  const s = await setup({
    verifyStep: async () => ({ ok: false, checks: [{ type: 'file', target: 'out', ok: false, expected: '存在', actual: '不存在' }] }),
  })
  try {
    await s.cards.saveUser(tutorialCard({ path: ['只有一步'] }))
    await s.by('tutorial_start').execute({ tutorialId: 'tut_invoice' })
    const goal = (await s.goals.list()).value[0]
    await s.by('goal_step_enter').execute({ goalId: goal.id, stepId: 's1' })
    await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's1', summary: '没做成' })
    await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's1', summary: '还是没做成' })

    const card = await s.cards.get('tut_invoice')
    assert.equal(card.value.health.fail, 1)
    assert.ok(card.value.health.status === 'needs-review' || card.value.health.status === 'broken')
  } finally {
    await s.cleanup()
  }
})
