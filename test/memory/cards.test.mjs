import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCardStore } from '../../src/memory/cards.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-he-cards-'))
  try {
    return await fn(createCardStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'test_card',
    title: 'test card',
    origin: 'builtin',
    version: 1,
    delivery: 'start',
    autonomy: 'supervised',
    goal: 'do the thing',
    constraints: ['be safe'],
    success: 'the thing is done',
    capabilities: [],
    params: {},
    enabled: true,
    ...overrides,
  }
}

test('installs a builtin card once', async () => {
  await withStore(async (store) => {
    const first = await store.installBuiltin(card())
    assert.equal(first.ok, true)
    assert.equal(first.value.skipped, false)
    assert.equal(first.value.card.origin, 'builtin')

    const second = await store.installBuiltin(card({ title: 'changed' }))
    assert.equal(second.value.skipped, true)
    assert.equal(second.value.card.title, 'test card')
  })
})

test('lists and filters cards', async () => {
  await withStore(async (store) => {
    await store.installBuiltin(card())
    await store.installBuiltin(card({ id: 'second_card', title: 'second' }))
    const all = await store.list()
    assert.equal(all.value.length, 2)
    const filtered = await store.list({ origin: 'user' })
    assert.equal(filtered.value.length, 0)
  })
})

test('saves a user card and bumps its version', async () => {
  await withStore(async (store) => {
    const first = await store.saveUser(card({ id: 'user_card' }))
    assert.equal(first.value.origin, 'user')
    assert.equal(first.value.version, 1)
    const second = await store.saveUser(card({ id: 'user_card', title: 'v2' }))
    assert.equal(second.value.version, 2)
  })
})

test('imported cards are forced to supervised', async () => {
  await withStore(async (store) => {
    const imported = await store.importCard(card({ id: 'imported_card', autonomy: 'full' }))
    assert.equal(imported.ok, true)
    assert.equal(imported.value.origin, 'imported')
    assert.equal(imported.value.autonomy, 'supervised')

    const duplicate = await store.importCard(card({ id: 'imported_card' }))
    assert.equal(duplicate.ok, false)
  })
})

test('enable/disable and remove', async () => {
  await withStore(async (store) => {
    await store.installBuiltin(card())
    const off = await store.setEnabled('test_card', false)
    assert.equal(off.value.enabled, false)
    const removed = await store.remove('test_card')
    assert.equal(removed.ok, true)
    const gone = await store.get('test_card')
    assert.equal(gone.ok, false)
  })
})

test('skips malformed card files', async () => {
  await withStore(async (store, dir) => {
    await store.installBuiltin(card())
    await mkdir(path.join(dir, 'cards'), { recursive: true })
    await writeFile(path.join(dir, 'cards', 'broken.json'), '{nope', 'utf8')
    const listed = await store.list()
    assert.equal(listed.value.length, 1)
  })
})
