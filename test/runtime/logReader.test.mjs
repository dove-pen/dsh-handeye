import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTailArgs, createLogReader, parseLogOutput, summarize, formatEvents } from '../../src/runtime/logReader.js'

function fixture(events = []) {
  return JSON.stringify({ count: events.length, events })
}

const SAMPLE = [
  { time: '2026-11-07 09:00:00', level: 4, levelName: '信息', source: '感知', eventId: 3003, category: '感知', desc: '筛子完成', detail: '[S=aaa] blocks=12' },
  { time: '2026-11-07 09:00:01', level: 3, levelName: '警告', source: '动作', eventId: 4013, category: '异常', desc: '危险动作被拦截', detail: '[S=aaa] text=删除' },
  { time: '2026-11-07 09:00:02', level: 2, levelName: '错误', source: '会话', eventId: 8001, category: '会话', desc: '会话结束', detail: '[S=bbb] rc=1 ms=20' },
]

test('builds argv with defaults', () => {
  assert.deepEqual(buildTailArgs(), ['log', '--json', '--tail', '200'])
})

test('builds argv with every filter and clamps the tail', () => {
  const argv = buildTailArgs({
    tail: 999999,
    level: '警告',
    source: '动作',
    id: 4001,
    grep: 'click',
    since: '2026-11-07',
  })
  assert.deepEqual(argv, [
    'log', '--json', '--tail', '2000',
    '--level', '警告',
    '--source', '动作',
    '--id', '4001',
    '--grep', 'click',
    '--since', '2026-11-07',
  ])
  assert.deepEqual(buildTailArgs({ tail: 'abc' }), ['log', '--json', '--tail', '200'])
})

test('parses and redacts log events', () => {
  const parsed = parseLogOutput(
    fixture([
      { ...SAMPLE[0], detail: '[S=aaa] token=ghp_' + 'H'.repeat(36) },
    ]),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.events.length, 1)
  assert.ok(!parsed.events[0].detail.includes('H'.repeat(36)))
  assert.ok(parsed.events[0].detail.includes('REDACTED'))
})

test('rejects invalid JSON and missing events', () => {
  assert.equal(parseLogOutput('not json').ok, false)
  assert.equal(parseLogOutput('{"count":0}').ok, false)
})

test('summarizes levels, sources and sessions', () => {
  const summary = summarize(SAMPLE)
  assert.equal(summary.total, 3)
  assert.equal(summary.byLevel[4], 1)
  assert.equal(summary.byLevel[3], 1)
  assert.equal(summary.byLevel[2], 1)
  assert.equal(summary.bySource['感知'], 1)
  assert.equal(summary.bySource['动作'], 1)
  assert.equal(summary.errors, 1)
  assert.equal(summary.warnings, 1)
  assert.equal(summary.sessions, 2)
  assert.equal(summary.lastTime, '2026-11-07 09:00:02')
})

test('caches identical reads for the cache window', async () => {
  let calls = 0
  let clock = 1000
  const reader = createLogReader({
    run: async () => {
      calls += 1
      return { ok: true, code: 0, stdout: fixture(SAMPLE) }
    },
    cacheMs: 2000,
    now: () => clock,
  })

  const first = await reader.tail({ tail: 10 })
  assert.equal(first.ok, true)
  assert.equal(calls, 1)

  await reader.tail({ tail: 10 })
  assert.equal(calls, 1, 'second identical read is served from cache')

  await reader.tail({ tail: 20 })
  assert.equal(calls, 2, 'different options bypass the cache')

  clock += 5000
  await reader.tail({ tail: 10 })
  assert.equal(calls, 3, 'expired cache is refreshed')
})

test('surfaces process failures as structured errors', async () => {
  const reader = createLogReader({
    run: async () => ({ ok: false, code: 3, stderr: 'boom' }),
  })
  const result = await reader.tail({})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INTERNAL')
  assert.ok(result.message.includes('3'))
})

test('formatEvents turns handeye level/source names into English', () => {
  const text = formatEvents([
    { time: '2026-11-13 20:57:34.817', level: 4, levelName: '信息', source: '会话', eventId: 8001, category: '会话', desc: '会话结束', detail: 'rc=0 ms=531' },
    { time: '2026-11-13 20:57:34.817', level: 2, levelName: '错误', source: '感知', eventId: 3003, category: '感知', desc: '筛子完成', detail: 'blocks=39' },
  ])
  assert.match(text, /Information  Session  #8001  Session/)
  assert.match(text, /Error  Perception  #3003  Perception/)
  assert.match(text, /rc=0 ms=531/)
})

test('formatEvents handles an empty list', () => {
  assert.equal(formatEvents([]), '(no matching log entries)')
})
