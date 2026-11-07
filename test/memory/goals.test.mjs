import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createGoalStore,
  validateGoal,
  normalizeSteps,
  summarizeGoal,
  newGoalId,
  DEFAULT_STEP_BUDGET,
} from '../../src/memory/goals.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-goals-'))
  try {
    return await fn(createGoalStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('newGoalId is sortable and matches the expected shape', () => {
  const id = newGoalId(new Date('2026-11-07T12:00:00Z'))
  assert.match(id, /^goal_20261107_[0-9a-f]{6}$/)
})

test('normalizeSteps accepts strings and objects, ids are positional', () => {
  const steps = normalizeSteps(['第一步', { title: '第二步', promptId: 'write_doc' }, '', null])
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map((s) => s.id), ['s1', 's2'])
  assert.equal(steps[1].promptId, 'write_doc')
  assert.equal(steps[0].status, 'todo')
  assert.equal(steps[0].budget.actions, DEFAULT_STEP_BUDGET)
  assert.deepEqual(normalizeSteps('nope'), [])
})

test('normalizeSteps caps the list at MAX_STEPS', () => {
  const many = Array.from({ length: 30 }, (_, i) => `步骤 ${i + 1}`)
  assert.equal(normalizeSteps(many).length, 20)
})

test('create + get round-trips through disk', async () => {
  await withStore(async (store) => {
    const created = await store.create({ title: '长期目标', longTermGoal: '把工具做成能长期用的', steps: ['摸清现状'] })
    assert.equal(created.ok, true, JSON.stringify(created.errors ?? []))
    const got = await store.get(created.value.id)
    assert.equal(got.ok, true)
    assert.equal(got.value.title, '长期目标')
    assert.equal(got.value.steps.length, 1)
    assert.equal(got.value.status, 'active')
  })
})

test('create rejects an empty title or goal', async () => {
  await withStore(async (store) => {
    assert.equal((await store.create({ title: '', longTermGoal: 'x' })).ok, false)
    assert.equal((await store.create({ title: 'x', longTermGoal: '' })).ok, false)
  })
})

test('list returns newest first and skips broken files', async () => {
  await withStore(async (store, dir) => {
    await store.create({ title: '第一个', longTermGoal: 'a' })
    await new Promise((r) => setTimeout(r, 5))
    await store.create({ title: '第二个', longTermGoal: 'b' })
    const listed = await store.list()
    assert.equal(listed.ok, true)
    assert.equal(listed.value.length, 2)
    assert.equal(listed.value[0].title, '第二个')
  })
})

test('setPlan replaces the steps and keeps them positional', async () => {
  await withStore(async (store) => {
    const created = await store.create({ title: 't', longTermGoal: 'g', steps: ['a'] })
    const saved = await store.setPlan(created.value.id, ['x', 'y', 'z'])
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.value.steps.map((s) => s.id), ['s1', 's2', 's3'])
  })
})

test('only one step may be doing at a time', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).value
    const first = await store.enterStep(g.id, 's1')
    assert.equal(first.ok, true)
    const second = await store.enterStep(g.id, 's2')
    assert.equal(second.ok, false)
    assert.match(second.message, /still running/)
  })
})

test('enterStep refuses a finished step and bumps attempts', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g', steps: ['a'] })).value
    await store.enterStep(g.id, 's1')
    await store.finishStep(g.id, 's1', { result: 'ok' })
    const again = await store.enterStep(g.id, 's1')
    assert.equal(again.ok, false)
    assert.match(again.message, /already done/)

    const g2 = (await store.create({ title: 't2', longTermGoal: 'g', steps: ['a'] })).value
    await store.enterStep(g2.id, 's1')
    const doc = (await store.get(g2.id)).value
    assert.equal(doc.steps[0].attempts, 1)
  })
})

test('verify failures block the step on the second attempt', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g', steps: ['a'] })).value
    await store.enterStep(g.id, 's1')
    const one = await store.recordVerifyFailure(g.id, 's1', 'file missing')
    assert.equal(one.value.failures, 1)
    assert.equal(one.value.blocked, false)
    const two = await store.recordVerifyFailure(g.id, 's1', 'file missing')
    assert.equal(two.value.failures, 2)
    assert.equal(two.value.blocked, true)
    const doc = (await store.get(g.id)).value
    assert.equal(doc.steps[0].status, 'blocked')
    assert.equal(doc.steps[0].blocks.length, 1)
    assert.match(doc.steps[0].blocks[0].reason, /verify failed twice/)
  })
})

test('finishStep clears the failure counter and records evidence', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g', steps: ['a'] })).value
    await store.enterStep(g.id, 's1')
    await store.recordVerifyFailure(g.id, 's1', 'x')
    const done = await store.finishStep(g.id, 's1', { result: 'ok', evidence: ['file ok'] })
    assert.equal(done.ok, true)
    assert.equal(done.value.step.status, 'done')
    assert.equal(done.value.step.verifyFailures, 0)
    assert.deepEqual(done.value.step.evidence, ['file ok'])
  })
})

test('skipStep records the reason and counts as finished progress', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g', steps: ['a', 'b'] })).value
    await store.enterStep(g.id, 's1')
    const skipped = await store.skipStep(g.id, 's1', '不需要了')
    assert.equal(skipped.ok, true)
    const summary = summarizeGoal(skipped.value.goal)
    assert.equal(summary.done, 1)
    assert.equal(summary.next, 's2')
  })
})

test('appendRun keeps the newest 100 records', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g' })).value
    for (let i = 0; i < 105; i += 1) await store.appendRun(g.id, { stepId: 's1', index: i })
    const doc = (await store.get(g.id)).value
    assert.equal(doc.runs.length, 100)
    assert.equal(doc.runs[99].index, 104)
  })
})

test('setStatus only accepts known statuses', async () => {
  await withStore(async (store) => {
    const g = (await store.create({ title: 't', longTermGoal: 'g' })).value
    assert.equal((await store.setStatus(g.id, 'nope')).ok, false)
    const paused = await store.setStatus(g.id, 'paused')
    assert.equal(paused.ok, true)
    assert.equal(paused.value.status, 'paused')
  })
})

test('validateGoal rejects two doing steps and duplicate ids', () => {
  const base = {
    schemaVersion: 1,
    id: 'goal_20261107_abcdef',
    title: 't',
    longTermGoal: 'g',
    status: 'active',
    steps: [
      { id: 's1', title: 'a', status: 'doing' },
      { id: 's2', title: 'b', status: 'doing' },
    ],
  }
  const twoDoing = validateGoal(base)
  assert.equal(twoDoing.ok, false)
  assert.ok(JSON.stringify(twoDoing.errors).includes('at most one step'))

  const dup = validateGoal({
    ...base,
    steps: [
      { id: 's1', title: 'a', status: 'todo' },
      { id: 's1', title: 'b', status: 'todo' },
    ],
  })
  assert.equal(dup.ok, false)
  assert.ok(JSON.stringify(dup.errors).includes('duplicate step id'))
})
