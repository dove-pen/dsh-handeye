import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEvents,
  episodesToEvents,
  goalsToEvents,
  skillsToEvents,
  filterEvents,
  summarize,
  refusalCode,
  sourceOf,
  LEVELS,
  EVENT_IDS,
} from '../../src/core/events.js'

function episode(overrides = {}) {
  return {
    id: 'ep_20261108_010101_aaaaaa',
    startedAt: '2026-11-08T01:01:01.000Z',
    intent: { text: '订阅一个邮件通讯', source: 'model' },
    steps: [
      { seq: 1, tool: 'browser_navigate', args: {}, ok: true, ms: 1200, brief: '已跳转到 https://a.example' },
      { seq: 2, tool: 'hand_click_text', args: {}, ok: true, ms: 300, brief: '点击了「订阅」' },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------- 映射

test('each step becomes one event, in order, with accumulated time', () => {
  const events = episodesToEvents([episode()])
  assert.equal(events.length, 2)
  assert.equal(events[0].eventId, 4001)
  assert.equal(events[0].level, 4)
  assert.equal(events[1].time - events[0].time, 1200)
})

test('a refused step is a warning from the gate, not a tool failure', () => {
  const events = episodesToEvents([
    episode({ steps: [{ seq: 1, tool: 'hand_type', args: {}, ok: false, ms: 5, brief: 'Refused: GOAL_STEP_REQUIRED — 先进入一个步骤' }] }),
  ])
  assert.equal(events[0].eventId, 2001)
  assert.equal(events[0].level, 3)
  assert.equal(events[0].source, 'Gate')
  assert.match(events[0].message, /GOAL_STEP_REQUIRED/)
})

test('a plain failure is an error', () => {
  const events = episodesToEvents([
    episode({ steps: [{ seq: 1, tool: 'browser_tabs', args: {}, ok: false, ms: 8, brief: 'browser_tabs 失败：fetch failed' }] }),
  ])
  assert.equal(events[0].eventId, 4002)
  assert.equal(events[0].level, 2)
  assert.equal(events[0].source, 'Browser')
})

test('refusalCode reads only the leading Refused: code', () => {
  assert.equal(refusalCode('Refused: PATH_DEVIATION — 连做 3 个动作'), 'PATH_DEVIATION')
  assert.equal(refusalCode('browser_tabs 失败'), '')
  assert.equal(refusalCode(''), '')
})

test('sources are grouped by tool family', () => {
  assert.equal(sourceOf('eye_see'), 'Hands')
  assert.equal(sourceOf('hand_click'), 'Hands')
  assert.equal(sourceOf('desk_windows'), 'Backend')
  assert.equal(sourceOf('browser_open'), 'Browser')
  assert.equal(sourceOf('voice_say'), 'Voice')
  assert.equal(sourceOf('goal_status'), 'Goals')
  assert.equal(sourceOf('skill_use'), 'Skills')
  assert.equal(sourceOf('mystery_tool'), 'Other')
})

test('blocked goal steps and completed goals produce goal events', () => {
  const base = {
    schemaVersion: 1,
    id: 'goal_20261108_abcdef',
    title: '整理发票',
    longTermGoal: 'x',
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T02:00:00.000Z',
    runs: [],
  }
  const blocked = goalsToEvents([{ ...base, status: 'active', steps: [{ id: 's1', title: '第一步', status: 'blocked', blockReason: '文件不存在' }] }])
  assert.equal(blocked[0].eventId, 3003)
  assert.match(blocked[0].message, /blocked/)
  assert.match(blocked[0].detail, /文件不存在/)

  const done = goalsToEvents([{ ...base, status: 'done', steps: [{ id: 's1', title: '第一步', status: 'done' }] }])
  assert.equal(done[0].eventId, 3004)
})

test('skill health produces run events, including the last failure reason', () => {
  const skill = {
    id: 'skill_20261108_01',
    title: '订阅',
    version: 1,
    origin: { kind: 'episode', createdAt: '2026-11-08T00:00:00.000Z' },
    steps: [{ id: 's1', intent: 'x' }],
    health: { runs: 3, ok: 2, fail: 1, lastRunAt: '2026-11-08T03:00:00.000Z', lastFailReason: '按钮找不到了', status: 'needs-review' },
  }
  const events = skillsToEvents([skill])
  assert.equal(events.length, 3)
  assert.equal(events.find((e) => e.eventId === 5003).level, 3)
  assert.match(events.find((e) => e.eventId === 5003).message, /按钮找不到了/)
})

test('events are sorted newest first and drop records without a usable time', () => {
  const events = buildEvents({
    episodes: [episode()],
    skills: [{ id: 's', title: 't', steps: [], health: {}, origin: {} }],
  })
  assert.ok(events.length >= 2)
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i - 1].time >= events[i].time)
  assert.ok(events.every((e) => e.time > 0))
})

// ---------------------------------------------------------------- 过滤与统计

test('level filter means "this severity and above"', () => {
  const events = episodesToEvents([
    episode({
      steps: [
        { seq: 1, tool: 'a', ok: true, ms: 1, brief: 'ok' },
        { seq: 2, tool: 'b', ok: false, ms: 1, brief: 'Refused: PATH_DEVIATION' },
        { seq: 3, tool: 'c', ok: false, ms: 1, brief: 'c 失败：x' },
      ],
    }),
  ])
  assert.equal(filterEvents(events, { level: 'all' }).length, 3)
  assert.equal(filterEvents(events, { level: '3' }).length, 2, 'Warning及以上，不含Information')
  assert.equal(filterEvents(events, { level: '2' }).length, 1, '只看Error')
})

test('search matches message, detail and source', () => {
  const events = episodesToEvents([episode()])
  assert.equal(filterEvents(events, { q: 'browser' }).length, 1)
  assert.equal(filterEvents(events, { q: '订阅' }).length, 2)
  assert.equal(filterEvents(events, { q: '不存在的东西' }).length, 0)
})

test('time window filter works', () => {
  const events = episodesToEvents([episode()])
  const t = Date.parse('2026-11-08T01:01:01.500Z')
  assert.equal(filterEvents(events, { sinceMs: Date.parse('2026-11-08T01:01:01.000Z') }).length, 2)
  assert.equal(filterEvents(events, { untilMs: Date.parse('2026-11-08T01:01:00.000Z') }).length, 0)
  assert.equal(filterEvents(events, { sinceMs: t }).length, 1)
})

test('summarize counts actions, refusals and severities', () => {
  const events = episodesToEvents([
    episode({
      steps: [
        { seq: 1, tool: 'a', ok: true, ms: 1, brief: 'ok' },
        { seq: 2, tool: 'b', ok: false, ms: 1, brief: 'Refused: X' },
        { seq: 3, tool: 'c', ok: false, ms: 1, brief: 'c 失败' },
      ],
    }),
  ])
  const sum = summarize(events)
  // 被拒绝的那次没有真的执行，所以不算"动作"：动作 2（一成一败），拒绝 1
  assert.equal(sum.actions, 2)
  assert.equal(sum.refused, 1)
  assert.equal(sum.failed, 1)
  assert.equal(sum.errors, 1)
  assert.equal(sum.warnings, 1)
})

test('every event id used has a label and a level', () => {
  const events = episodesToEvents([episode()])
  for (const e of events) {
    assert.ok(EVENT_IDS[e.eventId], '未知事件 ID ' + e.eventId)
    assert.equal(e.levelText, LEVELS[e.level])
    assert.ok(e.category && e.category !== 'Other', '事件应有任务类别')
  }
})
