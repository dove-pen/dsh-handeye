import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCardStore } from '../../src/memory/cards.js'
import { loadPack, installPack, substitutePackChecks } from '../../src/packs/loader.js'

const GOOD_PACK = {
  schemaVersion: 1,
  name: 'demo',
  version: '0.1.0',
  description: '测试用领域包',
  verify: [{ name: '合计一致', checks: [{ type: 'exit', command: 'node "{{packCheck:total}}" a.csv' }] }],
  cards: [
    {
      schemaVersion: 1,
      id: 'demo_card',
      title: '演示卡片',
      origin: 'imported',
      version: 1,
      delivery: 'start',
      autonomy: 'supervised',
      category: 'demo',
      goal: '验证领域包能装进本地库',
      path: ['第一步', '第二步'],
      constraints: [],
      success: '卡片出现在本地库里',
      verify: [{ type: 'exit', command: 'node "{{packCheck:total}}" a.csv' }],
    },
  ],
  skills: [],
}

async function makePack(pack = GOOD_PACK) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-'))
  await mkdir(path.join(dir, 'checks'), { recursive: true })
  await writeFile(path.join(dir, 'checks', 'total.mjs'), '// stub\n', 'utf8')
  await writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8')
  return dir
}

test('a well-formed pack loads and validates', async () => {
  const dir = await makePack()
  try {
    const loaded = loadPack(dir)
    assert.equal(loaded.ok, true, loaded.message)
    assert.equal(loaded.value.pack.name, 'demo')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a broken pack is rejected with a readable reason', async () => {
  const broken = { ...GOOD_PACK }
  delete broken.cards
  const dir = await makePack(broken)
  try {
    const loaded = loadPack(dir)
    assert.equal(loaded.ok, false)
    assert.match(loaded.message, /领域包格式不对/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing pack.json fails without throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-'))
  try {
    const loaded = loadPack(dir)
    assert.equal(loaded.ok, false)
    assert.match(loaded.message, /读不到/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('packCheck placeholders become real script paths', async () => {
  const dir = await makePack()
  try {
    const pack = loadPack(dir).value.pack
    const resolved = substitutePackChecks(pack.verify[0].checks[0].command, dir)
    assert.match(resolved, /checks\\total\.mjs"/)
    assert.ok(resolved.startsWith('node "'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installing puts cards into the store with the resolved command', async () => {
  const dir = await makePack()
  const cardsDir = await mkdtemp(path.join(tmpdir(), 'cards-'))
  try {
    const cards = createCardStore({ dir: cardsDir })
    const result = await installPack(dir, { cards })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.value.installed.length, 1)

    const stored = await cards.get('demo_card')
    assert.equal(stored.ok, true)
    assert.match(stored.value.verify[0].command, /checks\\total\.mjs"/)
    assert.equal(stored.value.category, 'demo')
    assert.equal(stored.value.origin, 'imported')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(cardsDir, { recursive: true, force: true })
  }
})

test('installing the same pack twice reports the conflict instead of silently overwriting', async () => {
  const dir = await makePack()
  const cardsDir = await mkdtemp(path.join(tmpdir(), 'cards-'))
  try {
    const cards = createCardStore({ dir: cardsDir })
    await installPack(dir, { cards })
    const again = await installPack(dir, { cards })
    assert.equal(again.ok, true)
    assert.equal(again.value.installed.length, 0)
    assert.equal(again.value.failed.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(cardsDir, { recursive: true, force: true })
  }
})
