import test from 'node:test'
import assert from 'node:assert/strict'

import { FORMATS_VERSION, schemas, validateSkill, validateVerify, validateDomainPack } from '../../src/formats/index.js'
import { compileSkills } from '../../src/memory/skills.js'

test('the vendored formats declare a version and load all three schemas', () => {
  assert.match(FORMATS_VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(schemas.skill.title.includes('技能'), true)
  assert.equal(schemas.verify.type, 'array')
  assert.ok(schemas.domainPack.properties.cards)
})

test('a compiled skill actually satisfies the published format', () => {
  // 这条是关键：编译器的产出必须能过格式校验，否则"格式独立"就是空话
  const episode = (id) => ({
    id,
    outcome: 'success',
    intent: { text: '订阅一个邮件通讯' },
    steps: [
      { tool: 'browser_navigate', args: { url: 'https://a.example' }, anchor: null, ok: true, ms: 1, brief: '' },
      { tool: 'hand_click_text', args: { text: '免费订阅' }, anchor: null, ok: true, ms: 1, brief: '' },
    ],
  })
  const drafts = compileSkills([episode('a'), episode('b'), episode('c')])
  assert.equal(drafts.length, 1)
  const shape = validateSkill(drafts[0])
  assert.equal(shape.ok, true, shape.message)
})

test('the format rejects a skill with an unknown field', () => {
  const bad = {
    schemaVersion: 1,
    id: 'skill_20261108_99',
    title: 'x',
    version: 1,
    origin: { kind: 'episode', createdAt: '2026-11-08T00:00:00Z' },
    steps: [{ id: 's1', intent: 'y', tool: 'z' }],
    health: { runs: 0, ok: 0, fail: 0, status: 'untested' },
    whatever: true,
  }
  const shape = validateSkill(bad)
  assert.equal(shape.ok, false)
  assert.match(shape.message, /not allowed/)
})

test('verify format rejects the shapes normalizeChecks also rejects', () => {
  assert.equal(validateVerify([{ type: 'file' }]).ok, false)
  // 结构层的错：text 既没有 file 也没有 screen:true
  assert.equal(validateVerify([{ type: 'text', appear: 'x' }]).ok, false, 'text 需要 file 或 screen')
  assert.equal(validateVerify([{ type: 'text', appear: 'x' }]).ok, false, 'text 需要 file 或 screen:true')
  // "appear / absent 二选一"是语义校验，由运行时的 normalizeChecks 负责（schema 只管形状）
  assert.equal(validateVerify([{ type: 'exit', command: '' }]).ok, false)
  assert.equal(validateVerify([{ type: 'file', path: 'a.txt' }]).ok, true)
})

test('a domain pack must carry cards', () => {
  const pack = { schemaVersion: 1, name: 'x', version: '0.1.0', description: 'd', verify: [] }
  assert.equal(validateDomainPack(pack).ok, false)
})
