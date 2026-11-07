import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyParams,
  validateCapability,
  validateCard,
  validateParamSchema,
} from '../../src/memory/schema.js'

function validCapability(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'check_balance',
    title: '查余额',
    description: '读取充值余额',
    risk: 'read',
    status: 'draft',
    params: { account: { type: 'string', required: false, default: 'auto' } },
    preconditions: [{ check: 'app', exe: 'chrome.exe' }],
    steps: [
      { op: 'open_url', url: 'https://platform.deepseek.com/usage' },
      { op: 'read_text', pattern: '¥([0-9.]+)', as: 'balance' },
    ],
    postconditions: [{ assert: 'isset', var: 'balance' }],
    outputs: ['balance'],
    ...overrides,
  }
}

function validCard(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'check_balance_card',
    title: '查余额',
    origin: 'user',
    version: 1,
    delivery: 'start',
    autonomy: 'supervised',
    goal: '读取 DeepSeek 充值余额',
    constraints: ['只读'],
    success: '拿到金额',
    capabilities: ['check_balance'],
    params: {},
    enabled: true,
    ...overrides,
  }
}

test('accepts a well-formed capability', () => {
  assert.deepEqual(validateCapability(validCapability()), { ok: true, errors: [] })
})

test('rejects bad names, ops and risk levels', () => {
  const badName = validateCapability(validCapability({ name: 'Bad Name' }))
  assert.equal(badName.ok, false)
  assert.ok(badName.errors.some((e) => e.path === 'name'))

  const badOp = validateCapability(validCapability({ steps: [{ op: 'rm_rf' }] }))
  assert.equal(badOp.ok, false)
  assert.ok(badOp.errors.some((e) => e.path === 'steps[0].op'))

  const badRisk = validateCapability(validCapability({ risk: 'dangerous' }))
  assert.equal(badRisk.ok, false)
  assert.ok(badRisk.errors.some((e) => e.path === 'risk'))
})

test('rejects empty and oversized step lists', () => {
  const empty = validateCapability(validCapability({ steps: [] }))
  assert.equal(empty.ok, false)
  const many = validateCapability(validCapability({ steps: Array.from({ length: 41 }, () => ({ op: 'screenshot' })) }))
  assert.equal(many.ok, false)
  assert.ok(many.errors.some((e) => e.path === 'steps'))
})

test('rejects unknown capability fields silently? no: unknown top-level fields are ignored but unknown params are not', () => {
  // Unknown top-level keys are tolerated for forward compatibility; the strict
  // part is the param schema, which is what users edit.
  const cap = validCapability({ futureField: true })
  assert.equal(validateCapability(cap).ok, true)
})

test('param schema validates types, enums and defaults', () => {
  const schema = {
    month: { type: 'enum', values: ['this', 'last'], default: 'this' },
    url: { type: 'url', required: true },
  }
  assert.equal(validateParamSchema(schema).ok, true)

  const bad = validateParamSchema({ month: { type: 'enum', values: [] } })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.path === 'params.month.values'))

  const good = applyParams(schema, { url: 'https://example.com' })
  assert.equal(good.ok, true)
  assert.deepEqual(good.values, { month: 'this', url: 'https://example.com' })

  const unknown = applyParams(schema, { url: 'https://example.com', nope: 1 })
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.some((e) => e.path === 'nope'))

  const wrongType = applyParams(schema, { url: 42 })
  assert.equal(wrongType.ok, false)

  const missing = applyParams(schema, {})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((e) => e.path === 'url'))
})

test('accepts a well-formed card', () => {
  assert.deepEqual(validateCard(validCard()), { ok: true, errors: [] })
})

test('rejects bad card autonomy and missing goal', () => {
  assert.equal(validateCard(validCard({ autonomy: 'yolo' })).ok, false)
  assert.equal(validateCard(validCard({ goal: '' })).ok, false)
})

test('an imported card can be validated but keeps its origin', () => {
  const card = validCard({ origin: 'imported' })
  assert.equal(validateCard(card).ok, true)
  assert.equal(card.origin, 'imported')
})
