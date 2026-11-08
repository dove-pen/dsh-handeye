import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSkillStore } from '../../src/memory/skillStore.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'skills-'))
  try {
    return await fn(createSkillStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function draft(id = 'skill_20261108_01') {
  return {
    schemaVersion: 1,
    id,
    title: '订阅一个邮件通讯',
    version: 1,
    origin: { kind: 'episode', episodeIds: ['ep_a', 'ep_b', 'ep_c'], createdAt: new Date().toISOString(), author: 'local' },
    params: [{ name: 'url', required: true }],
    steps: [{ id: 's1', intent: '打开', tool: 'browser_navigate', args: {}, anchor: null, expect: null, onFail: 'stop' }],
    health: { runs: 0, ok: 0, fail: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
    incomplete: { stepsWithoutChecks: 1, fragileSteps: 0 },
  }
}

test('save then list round-trips through disk', async () => {
  await withStore(async (store) => {
    const saved = await store.save(draft())
    assert.equal(saved.ok, true, JSON.stringify(saved.errors ?? []))
    const listed = await store.list()
    assert.equal(listed.value.length, 1)
    assert.equal(listed.value[0].title, '订阅一个邮件通讯')
  })
})

test('a bad id or empty title is rejected instead of written', async () => {
  await withStore(async (store) => {
    assert.equal((await store.save({ ...draft(), id: '../../evil' })).ok, false)
    assert.equal((await store.save({ ...draft(), title: '   ' })).ok, false)
  })
})

test('saving the same id again bumps the version', async () => {
  await withStore(async (store) => {
    await store.save(draft())
    const again = await store.save(draft())
    assert.equal(again.value.version, 2)
  })
})

test('health: a success marks it healthy and resets the failure streak', async () => {
  await withStore(async (store) => {
    await store.save(draft())
    const r = await store.recordRun('skill_20261108_01', { outcome: 'success' })
    assert.equal(r.value.health.runs, 1)
    assert.equal(r.value.health.ok, 1)
    assert.equal(r.value.health.status, 'healthy')
    assert.equal(r.value.health.failsInRow, 0)
  })
})

test('health: one failure with a low rate needs review', async () => {
  await withStore(async (store) => {
    await store.save(draft())
    await store.recordRun('skill_20261108_01', { outcome: 'success' })
    const r = await store.recordRun('skill_20261108_01', { outcome: 'failure', reason: '按钮找不到了' })
    assert.equal(r.value.health.status, 'needs-review')
    assert.match(r.value.health.lastFailReason, /按钮/)
  })
})

test('health: three failures in a row mark it broken', async () => {
  await withStore(async (store) => {
    await store.save(draft())
    await store.recordRun('skill_20261108_01', { outcome: 'failure' })
    await store.recordRun('skill_20261108_01', { outcome: 'failure' })
    const r = await store.recordRun('skill_20261108_01', { outcome: 'failure' })
    assert.equal(r.value.health.status, 'broken')
    assert.equal(r.value.health.failsInRow, 3)
  })
})

test('a broken skill can recover after successes', async () => {
  await withStore(async (store) => {
    await store.save(draft())
    for (let i = 0; i < 3; i += 1) await store.recordRun('skill_20261108_01', { outcome: 'failure' })
    // 修好之后连续成功：连续失败数清零，状态回到 healthy
    await store.recordRun('skill_20261108_01', { outcome: 'success' })
    const r = await store.recordRun('skill_20261108_01', { outcome: 'success' })
    assert.equal(r.value.health.failsInRow, 0)
    assert.equal(r.value.health.status, 'needs-review', '历史失败还在，成功率低于 90%')
  })
})

test('recording a run for an unknown skill fails clearly', async () => {
  await withStore(async (store) => {
    const r = await store.recordRun('skill_20260101_99', { outcome: 'success' })
    assert.equal(r.ok, false)
  })
})
