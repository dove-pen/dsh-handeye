import test from 'node:test'
import assert from 'node:assert/strict'

import { createExecutor } from '../../src/runtime/executor.js'
import { createConfirmStore } from '../../src/runtime/confirm.js'
import { beginEpisode, createState, pause } from '../../src/core/state.js'

function capability(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'check_balance',
    title: 'check balance',
    risk: 'read',
    status: 'enabled',
    params: { account: { type: 'string', default: 'auto' } },
    preconditions: [{ check: 'app' }],
    steps: [
      { op: 'open_url', url: 'https://example.com' },
      { op: 'read_text', pattern: 'x', as: 'balance' },
    ],
    postconditions: [{ assert: 'isset', var: 'balance' }],
    outputs: ['balance'],
    ...overrides,
  }
}

function fakeOps({ failAt = -1 } = {}) {
  const seen = []
  return {
    seen,
    async checkPrecondition() {
      return { ok: true }
    },
    async run(step) {
      seen.push(step)
      if (failAt >= 0 && seen.length - 1 === failAt) return { ok: false, message: 'not found', actual: 'nothing' }
      if (step.op === 'read_text') return { ok: true, vars: { balance: '18.21' }, brief: '18.21' }
      return { ok: true, brief: step.op }
    },
    async checkPostcondition(post, vars) {
      return { ok: Object.prototype.hasOwnProperty.call(vars, post.var), message: 'missing var' }
    },
  }
}

function setup(opts = {}) {
  const state = createState()
  beginEpisode(state, 'test')
  const ops = fakeOps(opts)
  const confirm = createConfirmStore()
  const executor = createExecutor({ state, ops, confirm })
  return { state, ops, confirm, executor }
}

test('runs a read capability and returns outputs, trace and assumptions', async () => {
  const { executor, ops } = setup()
  const result = await executor.run(capability(), {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { balance: '18.21' })
  assert.equal(result.trace.length, 2)
  assert.deepEqual(result.assumptions, { account: 'auto' })
  assert.equal(ops.seen.length, 2)
})

test('supplied params override defaults and remove assumptions', async () => {
  const { executor } = setup()
  const result = await executor.run(capability(), { account: 'work' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.assumptions, {})
})

test('rejects unknown parameters', async () => {
  const { executor } = setup()
  const result = await executor.run(capability(), { nope: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PARAMS_INVALID')
})

test('write capabilities require a confirmation token', async () => {
  const { executor, confirm } = setup()
  const cap = capability({ risk: 'write' })
  const refused = await executor.run(cap, {})
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'CONFIRM_REQUIRED')

  const token = confirm.mint('write', 'test')
  const allowed = await executor.run(cap, {}, { token })
  assert.equal(allowed.ok, true)
})

test('fails fast on a precondition', async () => {
  const { executor, ops } = setup()
  ops.checkPrecondition = async () => ({ ok: false, message: 'chrome not running' })
  const result = await executor.run(capability(), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PRECONDITION_FAILED')
  assert.equal(ops.seen.length, 0)
})

test('reports the failing step with its trace', async () => {
  const { executor } = setup({ failAt: 1 })
  const result = await executor.run(capability(), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STEP_FAILED')
  assert.equal(result.details.step, 1)
  assert.equal(result.details.trace.length, 2)
  assert.equal(result.details.trace[1].ok, false)
})

test('reports a failed postcondition', async () => {
  const { executor, ops } = setup()
  ops.checkPostcondition = async () => ({ ok: false, message: 'balance missing' })
  const result = await executor.run(capability(), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'POSTCONDITION_FAILED')
})

test('refuses to run while paused', async () => {
  const { state, executor } = setup()
  pause(state, 'manual')
  const result = await executor.run(capability(), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PAUSED')
})

test('refuses draft capabilities', async () => {
  const { executor } = setup()
  const result = await executor.run(capability({ status: 'draft' }), {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CAPABILITY_INVALID')
})

test('substitutes parameters into step strings', async () => {
  const { executor, ops } = setup()
  const cap = capability({
    params: { account: { type: 'string' } },
    steps: [{ op: 'type_text', text: 'hello ${account}' }],
    postconditions: [],
    outputs: [],
  })
  const result = await executor.run(cap, { account: 'work' })
  assert.equal(result.ok, true)
  assert.equal(ops.seen[0].text, 'hello work')
})
