import test from 'node:test'
import assert from 'node:assert/strict'

import { containsSecret, redactDeep, redactText } from '../../src/memory/redact.js'

test('masks GitHub tokens', () => {
  const token = 'ghp_' + 'A'.repeat(36)
  const out = redactText(`token is ${token}`)
  assert.ok(!out.includes(token))
  assert.ok(out.includes('gh*_REDACTED'))
})

test('masks fine-grained GitHub tokens and generic API keys', () => {
  const fine = 'github_pat_' + 'B'.repeat(30)
  const sk = 'sk-' + 'C'.repeat(32)
  assert.ok(!redactText(fine).includes(fine))
  assert.ok(!redactText(sk).includes(sk))
})

test('masks bearer headers and key=value credentials', () => {
  assert.ok(!redactText('Authorization: Bearer abc.def-123').includes('abc.def-123'))
  const pair = redactText('password=hunter2&user=bob')
  assert.ok(pair.includes('password=REDACTED'))
  assert.ok(!pair.includes('hunter2'))
})

test('masks phone numbers and ID numbers', () => {
  assert.equal(redactText('call 13812345678 now'), 'call 1********** now')
  assert.equal(redactText('id 11010519491231002X end'), 'id ****************** end')
})

test('leaves ordinary text alone', () => {
  const text = 'screen 1440x900, 3 files, hello world'
  assert.equal(redactText(text), text)
})

test('redacts nested objects and arrays deeply', () => {
  const value = {
    token: 'ghp_' + 'D'.repeat(36),
    nested: { list: ['sk-' + 'E'.repeat(32), 'plain'] },
    count: 3,
    ok: true,
  }
  const out = redactDeep(value)
  assert.ok(!JSON.stringify(out).includes('D'.repeat(36)))
  assert.ok(!JSON.stringify(out).includes('E'.repeat(32)))
  assert.equal(out.count, 3)
  assert.equal(out.ok, true)
  assert.equal(out.nested.list[1], 'plain')
})

test('handles cycles without throwing', () => {
  const value = { name: 'x' }
  value.self = value
  const out = redactDeep(value)
  assert.equal(out.self, '[Circular]')
})

test('is idempotent', () => {
  const once = redactText('password=abc ghp_' + 'F'.repeat(36))
  const twice = redactText(once)
  assert.equal(twice, once)
})

test('containsSecret detects the same patterns', () => {
  assert.equal(containsSecret('plain text'), false)
  assert.equal(containsSecret('ghp_' + 'G'.repeat(36)), true)
  assert.equal(containsSecret('password=abc'), true)
})
