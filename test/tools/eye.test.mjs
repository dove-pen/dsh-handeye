import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWaitArgs,
  buildFindArgs,
  buildRegionArgs,
  parseSeeJson,
  formatWaitResult,
} from '../../src/eye.js'

test('buildWaitArgs always carries a bounded timeout', () => {
  const args = buildWaitArgs({ text: '保存', timeoutMs: 5000 })
  assert.equal(args[0], 'see')
  assert.ok(args.includes('--wait'))
  assert.ok(args.includes('保存'))
  assert.equal(args[args.indexOf('--timeout') + 1], '5000')
  assert.ok(args.includes('--json'))
  // appear is one blocking call: default to the accurate profile, not the fast one
  assert.ok(args.includes('--best'))
  assert.ok(!args.includes('--fast'))

  const fast = buildWaitArgs({ text: 'x', timeoutMs: 5000, fast: true })
  assert.ok(fast.includes('--fast'))
  assert.ok(!fast.includes('--best'))

  const best = buildWaitArgs({ text: 'x', timeoutMs: 1, fast: false })
  assert.equal(best[best.indexOf('--timeout') + 1], '200')
  assert.ok(best.includes('--best'))
})

test('buildFindArgs asks for hits, not for a projection', () => {
  const args = buildFindArgs({ text: 'Notepad' })
  assert.ok(args.includes('--find'))
  assert.equal(args[args.indexOf('--find') + 1], 'Notepad')
  assert.ok(args.includes('--json'))
  assert.ok(args.includes('--fast'))
})

test('buildRegionArgs clamps the OCR scale to 1..4', () => {
  const normal = buildRegionArgs({ region: '1,2,3,4', scale: 3 })
  assert.equal(normal[normal.indexOf('--region') + 1], '1,2,3,4')
  assert.equal(normal[normal.indexOf('--scale') + 1], '3')

  const big = buildRegionArgs({ region: '1,2,3,4', scale: 99 })
  assert.equal(big[big.indexOf('--scale') + 1], '4')

  const small = buildRegionArgs({ region: '1,2,3,4', scale: 0 })
  assert.equal(small[small.indexOf('--scale') + 1], '1')
})

test('parseSeeJson reads the first JSON line and ignores noise', () => {
  assert.deepEqual(parseSeeJson('{"ok":true,"found":true,"x":1}'), { ok: true, found: true, x: 1 })
  assert.deepEqual(parseSeeJson('{"ok":true}\nsecond line'), { ok: true })
  assert.equal(parseSeeJson('not json at all'), null)
  assert.equal(parseSeeJson(''), null)
  assert.equal(parseSeeJson(null), null)
})

test('formatWaitResult reports a hit with coordinates and elapsed time', () => {
  const text = formatWaitResult({ found: true, x: 10, y: 20, w: 30, h: 40, elapsedMs: 120 }, { text: '确定' })
  assert.match(text, /"确定" appeared/)
  assert.match(text, /@\(10,20 30x40\)/)
  assert.match(text, /120ms/)
})

test('formatWaitResult on timeout names the failure and suggests the next step', () => {
  const text = formatWaitResult({ found: false, error: 'timeout', elapsedMs: 8000 }, { text: '保存' })
  assert.match(text, /waiting for "保存" failed: timed out/)
  assert.match(text, /eye_see/)
})

test('formatWaitResult for mode=gone reports disappearance', () => {
  const text = formatWaitResult({ found: false, gone: true, elapsedMs: 300 }, { text: '加载中', mode: 'gone' })
  assert.match(text, /is gone/)
})

test('formatWaitResult survives a null payload', () => {
  assert.match(formatWaitResult(null, { text: 'x' }), /returned nothing/)
})
