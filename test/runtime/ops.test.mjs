import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

import { createOps } from '../../src/runtime/ops.js'

function fakePrimitives(options = {}) {
  const calls = []
  let polls = 0
  const viewText = options.viewText ?? '余额 ¥18.21 充值余额'
  const browserText = options.browserText ?? 'page body'

  return {
    calls,
    primitives: {
      async launch(target) {
        calls.push(['launch', target])
        return { ok: true }
      },
      async focusWindow(title) {
        calls.push(['focus', title])
        return { ok: true }
      },
      async clickText(text, opts) {
        calls.push(['click', text, opts])
        return { ok: options.clickOk !== false }
      },
      async typeText(text) {
        calls.push(['type', text])
        return { ok: true }
      },
      async pressKey(key) {
        calls.push(['key', key])
        return { ok: true }
      },
      async seeJson() {
        calls.push(['see'])
        const text = typeof viewText === 'function' ? viewText(polls++) : viewText
        return { blocks: [{ items: [{ text }] }] }
      },
      async screenshot(path) {
        calls.push(['shot', path])
        return { ok: true }
      },
      async browserOpen(url) {
        calls.push(['bopen', url])
        return { ok: true }
      },
      async browserText() {
        calls.push(['btext'])
        return { ok: true, text: typeof browserText === 'function' ? browserText(polls++) : browserText }
      },
      async systemInfo(scope) {
        calls.push(['sysinfo', scope])
        return { ok: true, text: 'time=2026-11-07T12:00:00 mem_free_gb=4.2' }
      },
    },
  }
}

function setup(options = {}) {
  let clock = 1000
  const { primitives, calls } = fakePrimitives(options)
  const ops = createOps({
    primitives,
    clock: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  return { ops, calls }
}

test('open_url uses the system browser by default and read_text reads the screen', async () => {
  const { ops, calls } = setup()
  const ctx = { vars: {} }

  const opened = await ops.run({ op: 'open_url', url: 'https://example.com' }, ctx)
  assert.equal(opened.ok, true)
  assert.deepEqual(calls[0], ['launch', 'https://example.com'])

  const read = await ops.run({ op: 'read_text', pattern: '¥([0-9.]+)', as: 'balance' }, ctx)
  assert.equal(read.ok, true)
  assert.equal(ctx.vars.balance, '18.21')
})

test('channel="browser" routes reads to the CDP page text', async () => {
  const { ops, calls } = setup({ browserText: 'hello from the page' })
  const ctx = { vars: {} }

  await ops.run({ op: 'open_url', url: 'https://example.com', channel: 'browser' }, ctx)
  assert.deepEqual(calls[0], ['bopen', 'https://example.com'])

  await ops.run({ op: 'read_text', as: 'body' }, ctx)
  assert.equal(ctx.vars.body, 'hello from the page')
})

test('wait_text polls until the text appears', async () => {
  let polls = 0
  const { ops } = setup({
    viewText: () => (polls++ < 2 ? 'loading' : '充值余额'),
  })
  const ctx = { vars: {} }
  const result = await ops.run({ op: 'wait_text', text: '充值余额', timeoutMs: 5000 }, ctx)
  assert.equal(result.ok, true)
})

test('wait_text fails with the elapsed budget', async () => {
  const { ops } = setup({ viewText: 'nothing here' })
  const result = await ops.run({ op: 'wait_text', text: '充值余额', timeoutMs: 1000 }, { vars: {} })
  assert.equal(result.ok, false)
  assert.match(result.message, /not found within 1000ms/)
})

test('click_text forwards the expected change', async () => {
  const { ops, calls } = setup()
  const result = await ops.run({ op: 'click_text', text: '确定', expect: '已保存' }, { vars: {} })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], ['click', '确定', { expect: '已保存' }])
})

test('type_text, press_key and focus_window call their primitives', async () => {
  const { ops, calls } = setup()
  const ctx = { vars: {} }
  await ops.run({ op: 'type_text', text: 'hello' }, ctx)
  await ops.run({ op: 'press_key', key: 'ENTER' }, ctx)
  await ops.run({ op: 'focus_window', title: 'Chrome' }, ctx)
  assert.deepEqual(calls.map((c) => c[0]), ['type', 'key', 'focus'])
})

test('screenshot defaults to a temp PNG path', async () => {
  const { ops, calls } = setup()
  const result = await ops.run({ op: 'screenshot' }, { vars: {} })
  assert.equal(result.ok, true)
  const target = calls[0][1]
  assert.ok(target.startsWith(os.tmpdir()))
  assert.ok(target.endsWith('.png'))
})

test('read_text fails when the pattern does not match', async () => {
  const { ops } = setup({ viewText: 'nothing useful' })
  const result = await ops.run({ op: 'read_text', pattern: '¥([0-9.]+)' }, { vars: {} })
  assert.equal(result.ok, false)
  assert.match(result.message, /pattern not found/)
  assert.equal(typeof result.actual, 'string')
})

test('unknown ops fail with a clear message', async () => {
  const { ops } = setup()
  const result = await ops.run({ op: 'teleport' }, { vars: {} })
  assert.equal(result.ok, false)
  assert.match(result.message, /unsupported op/)
})

test('system_info stores the report in the requested variable', async () => {
  const { ops, calls } = setup()
  const ctx = { vars: {} }
  const result = await ops.run({ op: 'system_info', scope: 'full', as: 'report' }, ctx)
  assert.equal(result.ok, true)
  assert.match(ctx.vars.report, /mem_free_gb/)
  assert.ok(calls.some((c) => c[0] === 'sysinfo' && c[1] === 'full'))
})

test('checkPrecondition text_present reads the screen', async () => {
  const { ops } = setup()
  const ok = await ops.checkPrecondition({ check: 'text_present', text: '充值余额' })
  assert.equal(ok.ok, true)

  const missing = await ops.checkPrecondition({ check: 'text_present', text: '不存在的文字' })
  assert.equal(missing.ok, false)
})

test('browser open waits for the page body, and read_text sees it', async () => {
  let polls = 0
  const { ops, calls } = setup({
    browserText: () => (polls++ < 2 ? '' : 'Example Domain'),
  })
  const ctx = { vars: {} }
  const opened = await ops.run({ op: 'open_url', url: 'https://example.com', channel: 'browser' }, ctx)
  assert.equal(opened.ok, true)
  assert.ok(calls.some((c) => c[0] === 'btext'), 'open_url polls the page text')

  const read = await ops.run({ op: 'read_text', as: 'body' }, ctx)
  assert.equal(read.ok, true)
  assert.equal(ctx.vars.body, 'Example Domain')
})

test('read_text fails instead of succeeding on an empty source', async () => {
  const { ops } = setup({ viewText: '   ' })
  const result = await ops.run({ op: 'read_text', as: 'text' }, { vars: {} })
  assert.equal(result.ok, false)
  assert.match(result.message, /no text/i)
})
