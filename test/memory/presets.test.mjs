import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateCapability } from '../../src/memory/schema.js'

const presetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'presets')

test('every preset is a valid capability', async () => {
  const files = (await readdir(presetsDir)).filter((n) => n.endsWith('.json'))
  assert.equal(files.length, 6, 'expected exactly six presets')

  const names = new Set()
  for (const file of files) {
    const doc = JSON.parse(await readFile(path.join(presetsDir, file), 'utf8'))
    const check = validateCapability(doc)
    assert.equal(check.ok, true, `${file}: ${JSON.stringify(check.errors)}`)
    assert.equal(doc.origin, 'builtin', `${file} must declare a builtin origin`)
    assert.ok(!names.has(doc.name), `duplicate preset name ${doc.name}`)
    names.add(doc.name)
  }
})

test('presets never declare destructive risk', async () => {
  const files = (await readdir(presetsDir)).filter((n) => n.endsWith('.json'))
  for (const file of files) {
    const doc = JSON.parse(await readFile(path.join(presetsDir, file), 'utf8'))
    assert.notEqual(doc.risk, 'destructive', `${file} must not be destructive`)
  }
})
