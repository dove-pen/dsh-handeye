import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateCard } from '../../src/memory/schema.js'
import { validateCapability } from '../../src/memory/schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const promptsDir = path.join(here, '..', '..', 'prompts')
const presetsDir = path.join(here, '..', '..', 'presets')

test('every task card is valid, unique and references an existing capability', async () => {
  const files = (await readdir(promptsDir)).filter((n) => n.endsWith('.json'))
  assert.ok(files.length >= 12, `expected at least 12 cards, got ${files.length}`)

  const presetFiles = (await readdir(presetsDir)).filter((n) => n.endsWith('.json'))
  const known = new Set()
  for (const file of presetFiles) {
    const preset = JSON.parse(await readFile(path.join(presetsDir, file), 'utf8'))
    assert.equal(validateCapability(preset).ok, true)
    known.add(preset.name)
  }

  const ids = new Set()
  for (const file of files) {
    const card = JSON.parse(await readFile(path.join(promptsDir, file), 'utf8'))
    const check = validateCard(card)
    assert.equal(check.ok, true, `${file}: ${JSON.stringify(check.errors)}`)
    assert.equal(card.origin, 'builtin', `${file} must be a builtin card`)
    assert.ok(!ids.has(card.id), `duplicate card id ${card.id}`)
    ids.add(card.id)
    for (const name of card.capabilities ?? []) {
      assert.ok(known.has(name), `${file} references unknown capability ${name}`)
    }
  }
})

test('cards keep autonomy conservative', async () => {
  const files = (await readdir(promptsDir)).filter((n) => n.endsWith('.json'))
  for (const file of files) {
    const card = JSON.parse(await readFile(path.join(promptsDir, file), 'utf8'))
    assert.notEqual(card.autonomy, 'full', `${file} must not be full autonomy`)
  }
})
