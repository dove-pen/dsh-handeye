import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createEpisodeStore, newEpisodeId } from '../../src/memory/episodes.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-he-episodes-'))
  try {
    return await fn(createEpisodeStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function episode(overrides = {}) {
  return {
    id: newEpisodeId(new Date('2026-11-07T09:00:00+08:00')),
    startedAt: '2026-11-07T09:00:00+08:00',
    intent: { text: 'check balance', source: 'model' },
    steps: [{ tool: 'eye_see', args: { level: 'L0' }, ok: true, ms: 430 }],
    outcome: 'success',
    ...overrides,
  }
}

test('appends an episode and reads it back redacted', async () => {
  await withStore(async (store) => {
    const ep = episode({
      steps: [{ tool: 'hand_type', args: { text: 'ghp_' + 'A'.repeat(36) }, ok: true }],
    })
    const appended = await store.append(ep)
    assert.equal(appended.ok, true)

    const listed = await store.list({ limit: 10 })
    assert.equal(listed.ok, true)
    assert.equal(listed.value.length, 1)
    const text = JSON.stringify(listed.value[0])
    assert.ok(!text.includes('A'.repeat(36)), 'secret is redacted on read')

    const one = await store.read(ep.id)
    assert.equal(one.ok, true)
    assert.equal(one.value.id, ep.id)
  })
})

test('writes one JSONL file per local day', async () => {
  await withStore(async (store, dir) => {
    // 这里必须用“不带时区偏移”的本地时间。实现按“跑测试这台机器的本地日期”分文件，
    // 写死 +08:00 的话在 UTC 的 runner 上会落到前一天（2026-11-06），CI 必挂。
    await store.append(episode({ id: 'ep_a', startedAt: '2026-11-06T23:00:00' }))
    await store.append(episode({ id: 'ep_b', startedAt: '2026-11-07T01:00:00' }))

    const sixth = await readFile(path.join(dir, 'episodes', '2026-11-06.jsonl'), 'utf8')
    const seventh = await readFile(path.join(dir, 'episodes', '2026-11-07.jsonl'), 'utf8')

    assert.ok(sixth.includes('ep_a'), 'the 23:00 episode lands in its own local day')
    assert.ok(!sixth.includes('ep_b'), 'the next local day does not bleed backwards')
    assert.ok(seventh.includes('ep_b'), 'the 01:00 episode lands in the next local day')
    assert.ok(!seventh.includes('ep_a'), 'the previous local day does not bleed forwards')
  })
})

test('lists newest first and honours limit', async () => {
  await withStore(async (store) => {
    await store.append(episode({ id: 'ep_old', startedAt: '2026-11-05T09:00:00+08:00' }))
    await store.append(episode({ id: 'ep_new', startedAt: '2026-11-07T09:00:00+08:00' }))
    await store.append(episode({ id: 'ep_mid', startedAt: '2026-11-06T09:00:00+08:00' }))

    const listed = await store.list({ limit: 2 })
    assert.deepEqual(listed.value.map((e) => e.id), ['ep_new', 'ep_mid'])
  })
})

test('filters by since', async () => {
  await withStore(async (store) => {
    await store.append(episode({ id: 'ep_old', startedAt: '2026-11-01T09:00:00+08:00' }))
    await store.append(episode({ id: 'ep_new', startedAt: '2026-11-07T09:00:00+08:00' }))
    const listed = await store.list({ since: '2026-11-05T00:00:00+08:00' })
    assert.deepEqual(listed.value.map((e) => e.id), ['ep_new'])
  })
})

test('returns NOT_FOUND for an unknown episode', async () => {
  await withStore(async (store) => {
    const result = await store.read('ep_missing')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NOT_FOUND')
  })
})

test('skips malformed lines instead of failing', async () => {
  await withStore(async (store, dir) => {
    const file = path.join(dir, 'episodes', '2026-11-07.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'not json\n{"id":"ep_ok","startedAt":"2026-11-07T09:00:00+08:00","steps":[],"outcome":"success"}\n', 'utf8')
    const listed = await store.list({})
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.value.map((e) => e.id), ['ep_ok'])
  })
})

test('prunes files older than keepDays', async () => {
  await withStore(async (store, dir) => {
    const file = path.join(dir, 'episodes', '2020-01-01.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{"id":"old"}\n', 'utf8')
    await store.append(episode())

    const removed = await store.prune({ keepDays: 30, nowMs: new Date('2026-11-07T00:00:00+08:00').getTime() })
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.value, ['2020-01-01.jsonl'])
  })
})
