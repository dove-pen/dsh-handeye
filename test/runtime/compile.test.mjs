import test from 'node:test'
import assert from 'node:assert/strict'

import { compileEpisode } from '../../src/runtime/compile.js'

function episode(steps) {
  return {
    id: 'ep_test',
    startedAt: '2026-11-07T10:00:00+08:00',
    intent: { text: 'test' },
    outcome: 'success',
    steps,
  }
}

const meta = { name: 'fill_and_submit', title: 'fill and submit' }

test('compiles semantic steps and classifies risk', () => {
  const result = compileEpisode(
    episode([
      { tool: 'eye_see', args: { level: 'L1' }, ok: true },
      { tool: 'hand_focus', args: { title: 'Chrome' }, ok: true },
      { tool: 'hand_click_text', args: { text: '登录' }, ok: true },
      { tool: 'hand_type', args: { text: 'hello' }, ok: true },
      { tool: 'hand_key', args: { key: 'ENTER' }, ok: true },
    ]),
    meta,
  )
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.capability.steps.map((s) => s.op),
    ['focus_window', 'click_text', 'type_text', 'press_key'],
  )
  assert.equal(result.capability.risk, 'write')
  assert.equal(result.capability.fromEpisode, 'ep_test')
  assert.equal(result.capability.status, 'draft')
  assert.ok(result.warnings.some((w) => /hard-coded/i.test(w)))
})

test('skips coordinate clicks and keeps going', () => {
  const result = compileEpisode(
    episode([
      { tool: 'hand_click', args: { x: 10, y: 20 }, ok: true },
      { tool: 'hand_click_text', args: { text: '确定' }, ok: true },
    ]),
    meta,
  )
  assert.equal(result.ok, true)
  assert.equal(result.capability.steps.length, 1)
  assert.ok(result.warnings.some((w) => /coordinate clicks/i.test(w)))
})

test('drops observations and fails when nothing is replayable', () => {
  const result = compileEpisode(
    episode([
      { tool: 'eye_see', args: {}, ok: true },
      { tool: 'desk_text', args: { hwnd: 1 }, ok: true },
      { tool: 'browser_text', args: {}, ok: true },
    ]),
    meta,
  )
  assert.equal(result.ok, false)
  assert.match(result.message, /No replayable steps/)
})

test('browser navigation compiles to a browser-channel open_url', () => {
  const result = compileEpisode(
    episode([{ tool: 'browser_navigate', args: { url: 'https://example.com' }, ok: true }]),
    meta,
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.capability.steps[0], {
    op: 'open_url',
    url: 'https://example.com',
    channel: 'browser',
  })
})

test('destructive text promotes the risk', () => {
  const result = compileEpisode(
    episode([{ tool: 'hand_type', args: { text: '删除整个目录' }, ok: true }]),
    { name: 'danger', title: 'danger' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.capability.risk, 'destructive')
})

test('rejects an invalid capability name', () => {
  const result = compileEpisode(episode([{ tool: 'hand_key', args: { key: 'ENTER' }, ok: true }]), {
    name: 'Bad Name',
    title: 'x',
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /invalid/i)
})

test('failed steps are not compiled', () => {
  const result = compileEpisode(
    episode([
      { tool: 'hand_key', args: { key: 'ENTER' }, ok: false },
      { tool: 'hand_key', args: { key: 'TAB' }, ok: true },
    ]),
    meta,
  )
  assert.equal(result.ok, true)
  assert.equal(result.capability.steps.length, 1)
  assert.equal(result.capability.steps[0].key, 'TAB')
})
