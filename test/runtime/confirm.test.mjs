import test from 'node:test'
import assert from 'node:assert/strict'

import { createConfirmStore } from '../../src/runtime/confirm.js'

test('mints and consumes a token once', () => {
  const store = createConfirmStore()
  const token = store.mint('write', 'run check')
  assert.equal(store.consume(token, 'write').ok, true)
  assert.equal(store.consume(token, 'write').ok, false, 'tokens are single-use')
})

test('rejects mismatched risk', () => {
  const store = createConfirmStore()
  const token = store.mint('write')
  const result = store.consume(token, 'destructive')
  assert.equal(result.ok, false)
  assert.match(result.message, /write/)
})

test('expires after the TTL', () => {
  let clock = 1000
  const store = createConfirmStore({ ttlMs: 100, now: () => clock })
  const token = store.mint('destructive')
  clock += 1000
  assert.equal(store.consume(token, 'destructive').ok, false)
})

test('refuses to mint for read actions', () => {
  const store = createConfirmStore()
  assert.throws(() => store.mint('read'))
})

test('a scoped grant is consumed once', () => {
  const store = createConfirmStore()
  store.grant('check_balance', 'read')
  assert.equal(store.consumeFor('check_balance', 'read').ok, true)
  assert.equal(store.consumeFor('check_balance', 'read').ok, false)
})

test('a scoped grant expires and checks its risk', () => {
  let clock = 1000
  const store = createConfirmStore({ ttlMs: 50, now: () => clock })
  store.grant('cap', 'write')
  clock += 500
  assert.equal(store.consumeFor('cap', 'write').ok, false)

  store.grant('cap', 'write')
  assert.equal(store.consumeFor('cap', 'destructive').ok, false)
})
