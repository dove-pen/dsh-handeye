import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSkillTools, stepsFromSkill, substituteDeep } from '../../src/tools/skills.js'
import { createGoalTools } from '../../src/tools/goals.js'
import { createGoalStore } from '../../src/memory/goals.js'
import { createSkillStore } from '../../src/memory/skillStore.js'
import { createState, beginEpisode } from '../../src/core/state.js'

function skillDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'skill_20261108_01',
    title: '订阅一个邮件通讯',
    version: 2,
    origin: { kind: 'episode', episodeIds: ['a', 'b', 'c'], createdAt: '2026-11-08T00:00:00Z', author: 'local' },
    params: [
      { name: 'url', required: true, example: 'https://example.com' },
      { name: 'email', required: true },
    ],
    steps: [
      {
        id: 's1',
        intent: '打开 {{url}}',
        tool: 'browser_navigate',
        args: { url: '{{url}}' },
        anchor: null,
        expect: { type: 'screen', appear: '订阅' },
        onFail: 'stop',
      },
      {
        id: 's2',
        intent: '填入 {{email}} 并提交',
        tool: 'browser_fill',
        args: { value: '{{email}}' },
        anchor: null,
        expect: null,
        onFail: 'stop',
      },
    ],
    health: { runs: 0, ok: 0, fail: 0, failsInRow: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
    incomplete: { stepsWithoutChecks: 1, fragileSteps: 0 },
    ...overrides,
  }
}

async function setup({ verifyStep } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'skills-loop-'))
  const goals = createGoalStore({ dir })
  const skills = createSkillStore({ dir })
  const state = createState()
  beginEpisode(state, 'skill use')

  const entered = []
  const left = []
  const goalTools = createGoalTools({
    state,
    goals,
    skills,
    verifyStep,
    prepareStepChecks: async ({ step }) => {
      state.verifyChecks = Array.isArray(step.verify) && step.verify.length ? step.verify : null
      return { checks: state.verifyChecks ? state.verifyChecks.length : 0 }
    },
    onStepEnter: async ({ goal, step }) => {
      entered.push(step.id)
      state.goalId = goal.id
      state.currentStep = { stepId: step.id, allowedTools: null, budgetActions: 8 }
      return { episodeId: 'ep_test', checks: 0 }
    },
    onStepLeave: async ({ stepId }) => {
      left.push(stepId)
      state.currentStep = null
    },
  })
  const skillTools = createSkillTools({ state, skills, goals })
  const by = (name) => [...goalTools, ...skillTools].find((t) => t.name === name)
  return { dir, goals, skills, state, by, entered, left, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 纯函数

test('{{params}} are substituted everywhere, including nested args', () => {
  const missing = new Set()
  const out = substituteDeep({ a: '{{x}}', b: ['{{x}}-y', { c: '{{x}}' }] }, { x: 'V' }, missing)
  assert.deepEqual(out, { a: 'V', b: ['V-y', { c: 'V' }] })
  assert.deepEqual([...missing], [])
})

test('a missing placeholder is reported, not silently blanked', () => {
  const missing = new Set()
  const out = substituteDeep('打开 {{url}}', {}, missing)
  assert.equal(out, '打开 {{url}}')
  assert.deepEqual([...missing], ['url'])
})

test('skill steps become goal steps with the acceptance rules carried over', () => {
  const { steps, missing } = stepsFromSkill(skillDoc(), { url: 'https://a.example', email: 'x@y.z' })
  assert.deepEqual(missing, [])
  assert.equal(steps.length, 2)
  assert.equal(steps[0].title, '打开 https://a.example')
  assert.deepEqual(steps[0].verify, [{ type: 'screen', appear: '订阅' }])
  assert.equal(steps[1].verify, null, '没判据的步骤不许伪造判据')
})

// ---------------------------------------------------------------- skill_use

test('skill_use compiles the skill into a goal and focuses it', async () => {
  const s = await setup()
  try {
    await s.skills.save(skillDoc())
    const out = await s.by('skill_use').execute({
      skillId: 'skill_20261108_01',
      params: { url: 'https://a.example', email: 'x@y.z' },
    })
    assert.match(out, /created from skill/)

    const listed = await s.goals.list()
    assert.equal(listed.value.length, 1)
    const goal = listed.value[0]
    assert.equal(goal.title, '订阅一个邮件通讯')
    assert.equal(goal.steps.length, 2)
    assert.equal(goal.meta.skillId, 'skill_20261108_01')
    assert.equal(goal.meta.skillVersion, 2)
    assert.equal(goal.steps[0].title, '打开 https://a.example')
    assert.deepEqual(goal.steps[0].verify, [{ type: 'screen', appear: '订阅' }])
    assert.equal(s.state.goalId, goal.id, '建目标即聚焦，和 goal_create 一致')
  } finally {
    await s.cleanup()
  }
})

test('skill_use refuses when a required param is missing', async () => {
  const s = await setup()
  try {
    await s.skills.save(skillDoc())
    const out = await s.by('skill_use').execute({ skillId: 'skill_20261108_01', params: { url: 'https://a.example' } })
    assert.match(out, /Missing params/)
    assert.match(out, /email/)
    const listed = await s.goals.list()
    assert.equal(listed.value.length, 0, 'Missing params不许建目标')
  } finally {
    await s.cleanup()
  }
})

test('skill_use refuses an unknown skill', async () => {
  const s = await setup()
  try {
    const out = await s.by('skill_use').execute({ skillId: 'skill_20260101_99' })
    assert.match(out, /Skill not found/)
  } finally {
    await s.cleanup()
  }
})

// ---------------------------------------------------------------- Health闭环

test('finishing the last goal step records a success on the skill', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    await s.skills.save(skillDoc())
    await s.by('skill_use').execute({ skillId: 'skill_20261108_01', params: { url: 'https://a.example', email: 'x@y.z' } })
    const goal = (await s.goals.list()).value[0]

    await s.by('goal_step_enter').execute({ goalId: goal.id, stepId: 's1' })
    await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's1', summary: '打开了' })
    await s.by('goal_step_enter').execute({ goalId: goal.id, stepId: 's2' })
    const out = await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's2', summary: '提交了' })
    assert.match(out, /Skill health \+1/)

    const health = await s.skills.get('skill_20261108_01')
    assert.equal(health.value.health.runs, 1)
    assert.equal(health.value.health.ok, 1)
    assert.equal(health.value.health.status, 'healthy')
  } finally {
    await s.cleanup()
  }
})

test('a blocked step records a failure and marks the skill for review', async () => {
  const s = await setup({
    verifyStep: async () => ({ ok: false, checks: [{ type: 'file', target: 'x', ok: false, expected: '存在', actual: '不存在' }] }),
  })
  try {
    await s.skills.save(skillDoc())
    await s.by('skill_use').execute({ skillId: 'skill_20261108_01', params: { url: 'https://a.example', email: 'x@y.z' } })
    const goal = (await s.goals.list()).value[0]
    await s.by('goal_step_enter').execute({ goalId: goal.id, stepId: 's1' })
    await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's1', summary: '没打开' })
    await s.by('goal_step_done').execute({ goalId: goal.id, stepId: 's1', summary: '还是没打开' })

    const health = await s.skills.get('skill_20261108_01')
    assert.equal(health.value.health.fail, 1, '卡住要记一次失败')
    assert.equal(health.value.health.status, 'needs-review')
  } finally {
    await s.cleanup()
  }
})

test('skill_health shows a single skill and the whole library', async () => {
  const s = await setup()
  try {
    await s.skills.save(skillDoc())
    const empty = await s.by('skill_health').execute({})
    assert.match(empty, /runs=0/)

    await s.skills.recordRun('skill_20261108_01', { outcome: 'failure', reason: 'button not found' })
    const one = await s.by('skill_health').execute({ skillId: 'skill_20261108_01' })
    assert.match(one, /Used 1 times/)
    assert.match(one, /button not found/)
  } finally {
    await s.cleanup()
  }
})
