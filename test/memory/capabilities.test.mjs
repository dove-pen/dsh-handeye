import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCapabilityStore } from '../../src/memory/capabilities.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-he-caps-'))
  try {
    return await fn(createCapabilityStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function capability(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'check_balance',
    title: '查余额',
    description: 'read the balance',
    risk: 'read',
    status: 'draft',
    params: {},
    preconditions: [],
    steps: [{ op: 'read_text', as: 'text' }],
    postconditions: [],
    outputs: ['text'],
    ...overrides,
  }
}

test('saves a valid draft with lifecycle metadata', async () => {
  await withStore(async (store) => {
    const saved = await store.saveDraft(capability())
    assert.equal(saved.ok, true)
    assert.equal(saved.value.status, 'draft')
    assert.equal(saved.value.origin, 'user')
    assert.equal(saved.value.stats.runs, 0)
    assert.equal(saved.value.firstRunConfirmed, false)
  })
})

test('rejects invalid capabilities', async () => {
  await withStore(async (store) => {
    const saved = await store.saveDraft(capability({ name: 'Bad Name' }))
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'CAPABILITY_INVALID')
  })
})

test('get returns NOT_FOUND for unknown names', async () => {
  await withStore(async (store) => {
    const result = await store.get('missing_cap')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NOT_FOUND')
  })
})

test('enable and disable move through the lifecycle', async () => {
  await withStore(async (store) => {
    await store.saveDraft(capability())
    const enabled = await store.enable('check_balance')
    assert.equal(enabled.ok, true)
    assert.equal(enabled.value.status, 'enabled')

    const disabled = await store.disable('check_balance')
    assert.equal(disabled.value.status, 'disabled')
  })
})

test('an enabled capability cannot be overwritten by a draft', async () => {
  await withStore(async (store) => {
    await store.saveDraft(capability())
    await store.enable('check_balance')
    const again = await store.saveDraft(capability())
    assert.equal(again.ok, false)
    assert.match(again.message, /Disable/)
  })
})

test('records run statistics', async () => {
  await withStore(async (store) => {
    await store.saveDraft(capability())
    await store.recordRun('check_balance', { ok: true, ms: 120 })
    await store.recordRun('check_balance', { ok: false, error: 'step failed' })
    const doc = await store.get('check_balance')
    assert.equal(doc.value.stats.runs, 2)
    assert.equal(doc.value.stats.success, 1)
    assert.equal(doc.value.stats.lastError, 'step failed')
  })
})

test('removes a capability', async () => {
  await withStore(async (store) => {
    await store.saveDraft(capability())
    const removed = await store.remove('check_balance')
    assert.equal(removed.ok, true)
    const after = await store.get('check_balance')
    assert.equal(after.ok, false)
  })
})

test('lists valid files and skips malformed ones', async () => {
  await withStore(async (store, dir) => {
    await store.saveDraft(capability())
    await store.saveDraft(capability({ name: 'open_page', title: 'open page' }))
    await mkdir(path.join(dir, 'capabilities'), { recursive: true })
    await writeFile(path.join(dir, 'capabilities', 'broken.json'), '{not json', 'utf8')

    const listed = await store.list()
    assert.equal(listed.ok, true)
    assert.equal(listed.value.length, 2)
  })
})

test('installPreset copies a builtin as disabled and is idempotent', async () => {
  await withStore(async (store) => {
    const preset = capability({ name: 'preset_cap', origin: 'imported' })
    const first = await store.installPreset(preset)
    assert.equal(first.ok, true)
    assert.equal(first.value.capability.origin, 'builtin')
    assert.equal(first.value.capability.status, 'disabled')

    const second = await store.installPreset(preset)
    assert.equal(second.ok, true)
    assert.equal(second.value.skipped, true)
  })
})

test('importCapability forces imported origin and disabled status', async () => {
  await withStore(async (store) => {
    const imported = await store.importCapability(capability({ name: 'imported_cap', origin: 'builtin' }))
    assert.equal(imported.ok, true)
    assert.equal(imported.value.origin, 'imported')
    assert.equal(imported.value.status, 'disabled')

    const duplicate = await store.importCapability(capability({ name: 'imported_cap' }))
    assert.equal(duplicate.ok, false)
  })
})
