import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createGoalTools } from '../../src/tools/goals.js'
import { createGoalStore } from '../../src/memory/goals.js'
import { createState, beginEpisode } from '../../src/core/state.js'

async function setup({ verifyStep, prepareStepChecks } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-goaltools-'))
  const store = createGoalStore({ dir })
  const state = createState()
  beginEpisode(state, 'goal work')
  const entered = []
  const left = []
  const tools = createGoalTools({
    state,
    goals: store,
    verifyStep,
    prepareStepChecks,
    onStepEnter: async ({ goal, step }) => {
      entered.push({ goalId: goal.id, stepId: step.id })
      state.goalId = goal.id
      state.currentStep = { stepId: step.id, allowedTools: null, budgetActions: 8 }
      return { episodeId: 'ep_test', checks: 1 }
    },
    onStepLeave: async ({ stepId, reason }) => {
      left.push({ stepId, reason })
      state.currentStep = null
    },
  })
  const by = (name) => tools.find((t) => t.name === name)
  return { dir, store, state, tools, by, entered, left, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('goal_create then goal_plan then goal_status', async () => {
  const s = await setup()
  try {
    const created = await s.by('goal_create').execute({ title: '长期目标', longTermGoal: '把工具做成能长期用的', steps: ['摸清现状'] })
    assert.match(created, /已建目标/)
    const id = created.match(/已建目标 (goal_\S+)：/)[1]

    const planned = await s.by('goal_plan').execute({ goalId: id, steps: ['摸清现状', '补点击安全', '做提示词库'] })
    assert.match(planned, /3 步/)
    assert.match(planned, /s3 做提示词库/)

    const status = await s.by('goal_status').execute({ goalId: id })
    assert.match(status, /0\/3 步/)
    assert.match(status, /下一步 s1/)

    const list = await s.by('goal_status').execute({})
    assert.match(list, /长期目标/)
  } finally {
    await s.cleanup()
  }
})

test('goal_step_enter binds the step and refuses a second one', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    const out = await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    assert.match(out, /已进入/)
    assert.match(out, /预算：8 个动作/)
    assert.equal(s.entered.length, 1)

    const second = await s.by('goal_step_enter').execute({ goalId: id, stepId: 's2' })
    assert.match(second, /失败：/)
    assert.match(second, /still running/)
  } finally {
    await s.cleanup()
  }
})

test('goal_step_done refuses when the acceptance check fails', async () => {
  const s = await setup({
    verifyStep: async () => ({
      ok: false,
      checks: [{ type: 'file', target: '文件 D:\\a.md', ok: false, expected: '存在', actual: '文件不存在' }],
    }),
  })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })

    const first = await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '做完了' })
    assert.match(first, /失败：这一步的验收没过/)
    assert.match(first, /文件不存在/)
    assert.equal(s.left.length, 0, 'step must not be left on failure')

    const second = await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '做完了' })
    assert.match(second, /blocked/)
    assert.match(second, /不要自己换办法硬刚/)
    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[0].status, 'blocked')
  } finally {
    await s.cleanup()
  }
})

test('goal_step_done finishes and reports the next step', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [{ type: 'file', target: 'f', ok: true, expected: 'x', actual: 'y' }] }) })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    const done = await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '写完了' })
    assert.match(done, /✓ 完成 s1/)
    assert.match(done, /1\/2 步/)
    assert.match(done, /goal_step_enter \S+ s2/)
    assert.equal(s.left.length, 1)

    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[0].status, 'done')
    assert.equal(doc.runs.length, 1)
    assert.equal(doc.runs[0].verify, 'pass')
  } finally {
    await s.cleanup()
  }
})

test('goal_step_continue extends the budget only with a reason', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })

    const noReason = await s.by('goal_step_continue').execute({ goalId: id, stepId: 's1', reason: '' })
    assert.match(noReason, /失败：/)

    const ok = await s.by('goal_step_continue').execute({ goalId: id, stepId: 's1', reason: '文件太多', extra: 5 })
    assert.match(ok, /追加 5 个动作/)
    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[0].budget.actions, 13)
  } finally {
    await s.cleanup()
  }
})

test('goal_skip_step needs a reason and moves progress forward', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    assert.match(await s.by('goal_skip_step').execute({ goalId: id, stepId: 's1', reason: '不' }), /失败：/)
    const ok = await s.by('goal_skip_step').execute({ goalId: id, stepId: 's1', reason: '这一步不需要了' })
    assert.match(ok, /已跳过 s1/)
    assert.match(ok, /1\/2 步/)
  } finally {
    await s.cleanup()
  }
})

test('a missing goal fails loudly instead of silently succeeding', async () => {
  const s = await setup()
  try {
    const out = await s.by('goal_step_enter').execute({ goalId: 'goal_20261107_zzzzzz', stepId: 's1' })
    assert.match(out, /失败：/)
  } finally {
    await s.cleanup()
  }
})

test('goal_create focuses the goal, so actions need a step', async () => {
  const s = await setup()
  try {
    const out = await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })
    const id = out.match(/已建目标 (goal_\S+)：/)[1]
    assert.equal(s.state.goalId, id, 'creating a goal adopts it')
    // 步骤门：此时写操作会被拒（gate 检查在 index.js 的包装里，这里只验证状态）
    assert.equal(s.state.currentStep, null)
  } finally {
    await s.cleanup()
  }
})

test('goal_set_status pauses the goal and releases the focus', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    assert.notEqual(s.state.currentStep, null)

    const out = await s.by('goal_set_status').execute({ goalId: id, status: 'paused' })
    assert.match(out, /现在是 paused/)
    assert.equal(s.state.goalId, '')
    assert.equal(s.state.currentStep, null)
    assert.equal(s.left.length, 1)
  } finally {
    await s.cleanup()
  }
})

test('a step with no acceptance checks records verify=none, not pass', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '做完了，但这步本来就没判据' })
    const doc = (await s.store.get(id)).value
    assert.equal(doc.runs[0].verify, 'none', '没跑判据就不能算验收通过')
  } finally {
    await s.cleanup()
  }
})

test('finishing the last step releases the goal, so unrelated actions are not blocked', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    assert.equal(s.state.goalId, id)
    const out = await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '做完了' })
    assert.match(out, /已退出步骤模式/)
    assert.equal(s.state.goalId, '', '做完最后一步必须放开目标，否则后续所有写操作都会被拦')
  } finally {
    await s.cleanup()
  }
})

test('an unfinished goal keeps its focus after a step finishes', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '第一步好了' })
    assert.equal(s.state.goalId, id, '还有下一步，焦点不能放开')
  } finally {
    await s.cleanup()
  }
})

test('a step cannot be closed while another step is running', async () => {
  const s = await setup({ verifyStep: async () => ({ ok: true, checks: [] }) })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    const out = await s.by('goal_step_done').execute({ goalId: id, stepId: 's2', summary: '偷跑' })
    assert.match(out, /没在跑/)
    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[1].status, 'todo', 's2 不能被隔空标成完成')
  } finally {
    await s.cleanup()
  }
})

test('结账前重新挂判据：重启后 state 空了也不能白送通过', async () => {
  const seen = []
  let s
  s = await setup({
    prepareStepChecks: async () => {
      // 模拟"从文件重新读出这一步的判据"
      s.state.verifyChecks = [{ type: 'file', path: 'x.md', minBytes: 1 }]
      return { checks: 1 }
    },
    verifyStep: async (state) => {
      const n = Array.isArray(state.verifyChecks) ? state.verifyChecks.length : 0
      seen.push(n)
      return n > 0
        ? { ok: false, checks: [{ type: 'file', target: 'x.md', ok: false, expected: '存在', actual: '文件不存在' }] }
        : { ok: true, checks: [] }
    },
  })
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: [{ title: 'a', verify: [{ type: 'file', path: 'x.md', minBytes: 1 }] }] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    // 模拟进程重启：内存里的判据没了
    s.state.verifyChecks = null
    const out = await s.by('goal_step_done').execute({ goalId: id, stepId: 's1', summary: '好了' })
    assert.match(out, /验收没过/)
    assert.deepEqual(seen, [1], '结账时必须先重挂判据再验')
    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[0].status, 'doing', '没验过就不能标完成')
  } finally {
    await s.cleanup()
  }
})

test('被卡住的步骤不能无理由重进', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    await s.store.recordVerifyFailure(id, 's1', '第一次失败')
    await s.store.recordVerifyFailure(id, 's1', '第二次失败')

    const noReason = await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    assert.match(noReason, /卡住/)

    const withReason = await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1', reason: '换个办法再来一次' })
    assert.match(withReason, /已进入/)
    const doc = (await s.store.get(id)).value
    assert.equal(doc.steps[0].status, 'doing')
    assert.equal(doc.steps[0].verifyFailures, 0, '重进要把失败计数清零')
  } finally {
    await s.cleanup()
  }
})

test('不能给不是正在跑的那一步续预算', async () => {
  const s = await setup()
  try {
    const id = (await s.by('goal_create').execute({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).match(/已建目标 (goal_\S+)：/)[1]
    await s.by('goal_step_enter').execute({ goalId: id, stepId: 's1' })
    const out = await s.by('goal_step_continue').execute({ goalId: id, stepId: 's2', reason: '这一堆文件要处理', extra: 5 })
    assert.match(out, /没在跑/)
  } finally {
    await s.cleanup()
  }
})
