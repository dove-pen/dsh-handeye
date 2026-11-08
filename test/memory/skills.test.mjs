import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAnchor, anchorKind, describeAnchor } from '../../src/memory/anchor.js'
import {
  compileSkills,
  compileSkill,
  clusterEpisodes,
  extractParams,
  similarity,
  episodeShape,
} from '../../src/memory/skills.js'

// ---------------------------------------------------------------- anchor

test('anchor prefers the explicit text argument', () => {
  const a = buildAnchor('hand_click_text', { text: '免费订阅' }, '命中窗口：Chrome（工作区）')
  assert.equal(a.kind, 'click-by-text')
  assert.equal(a.text, '免费订阅')
  assert.equal(a.container, 'Chrome（工作区）')
  assert.equal(a.fragile, false)
  assert.equal(a.source, 'args.text')
})

test('a pure coordinate click is marked fragile', () => {
  const a = buildAnchor('hand_click', { x: 700, y: 400, title: 'Chrome' }, '')
  assert.equal(a.fragile, true)
  assert.equal(a.source, 'args.coords')
  assert.deepEqual(a.point, { x: 700, y: 400 })
  assert.equal(a.container, 'Chrome')
  assert.match(describeAnchor(a), /换屏幕/)
})

test('knowing only the window name is not enough to be portable', () => {
  const a = buildAnchor('desk_invoke', {}, '已触发 42（方式 uia），鼠标没有移动。\n命中窗口：记事本')
  assert.equal(a.container, '记事本')
  assert.equal(a.source, 'output.window')
  // 只知道"在记事本里"、不知道点的是哪个控件 -> 仍然脆弱
  assert.equal(a.fragile, true)
})

test('unknown tools fall back to kind=other without inventing data', () => {
  const a = buildAnchor('weird_tool', {}, '')
  assert.equal(a.kind, 'other')
  assert.equal(a.text, '')
  assert.equal(a.fragile, true)
  assert.equal(anchorKind('browser_fill'), 'fill-element')
})

// ---------------------------------------------------------------- skills

function episode({ id, tools, intent = '订阅一个通讯', outcome = 'success', anchors = {}, varying = {} }) {
  return {
    id,
    outcome,
    intent: { text: intent },
    steps: tools.map((tool, i) => ({
      seq: i + 1,
      tool,
      args: { ...(varying[i] ?? {}), ...(varying[`${i}`]?.args ?? {}) },
      anchor: anchors[i] ?? null,
      ok: true,
      ms: 100,
      brief: '',
    })),
  }
}

const TOOLS = ['browser_navigate', 'browser_fill', 'browser_click']

test('similar runs cluster, different ones do not', () => {
  const a = episodeShape(episode({ id: 'a', tools: TOOLS }))
  const b = episodeShape(episode({ id: 'b', tools: TOOLS }))
  const c = episodeShape(episode({ id: 'c', tools: ['hand_click', 'hand_type'] }))
  assert.ok(similarity(a, b) >= 0.8)
  assert.ok(similarity(a, c) < 0.8)
})

test('failed and empty episodes are never clustered', () => {
  const groups = clusterEpisodes([
    episode({ id: 'a', tools: TOOLS, outcome: 'failure' }),
    { id: 'b', outcome: 'success', steps: [], intent: { text: 'x' } },
  ])
  assert.equal(groups.length, 0)
})

test('three similar runs produce exactly one draft', () => {
  const eps = [
    episode({ id: 'a', tools: TOOLS, anchors: { 0: { kind: 'navigate', text: '', container: 'Chrome', fragile: false } } }),
    episode({ id: 'b', tools: TOOLS }),
    episode({ id: 'c', tools: TOOLS }),
  ]
  const drafts = compileSkills(eps)
  assert.equal(drafts.length, 1)
  const draft = drafts[0]
  assert.equal(draft.origin.kind, 'episode')
  assert.equal(draft.origin.episodeIds.length, 3)
  assert.equal(draft.steps.length, 3)
  assert.equal(draft.health.status, 'untested')
  assert.equal(draft.steps[0].expect, null, 'v1 不伪造判据')
  assert.ok(draft.incomplete.stepsWithoutChecks > 0, '没判据要如实标出来')
})

test('two runs are not enough by default', () => {
  const eps = [episode({ id: 'a', tools: TOOLS }), episode({ id: 'b', tools: TOOLS })]
  assert.equal(compileSkills(eps).length, 0)
  assert.equal(compileSkills(eps, { minRuns: 2 }).length, 1)
})

test('values that differ between runs become parameters; coordinates never do', () => {
  const runs = [
    episode({ id: 'a', tools: TOOLS, varying: { 1: { url: 'https://a.example', x: 10, y: 20 } } }),
    episode({ id: 'b', tools: TOOLS, varying: { 1: { url: 'https://b.example', x: 30, y: 40 } } }),
    episode({ id: 'c', tools: TOOLS, varying: { 1: { url: 'https://c.example', x: 50, y: 60 } } }),
  ]
  const params = extractParams(runs)
  assert.equal(params.length, 1)
  assert.equal(params[0].name, 'url')

  const draft = compileSkill({ shape: episodeShape(runs[0]), episodes: runs })
  assert.equal(draft.params[0].name, 'url')
  assert.equal(draft.steps[1].args.url, '{{url}}', '参数要变成占位符')
  assert.equal(draft.steps[1].args.x, undefined, '坐标绝不进模板')
})

test('a run whose values all differ wildly is not templated into a broken skill', () => {
  const long = (n) => `C:\\Users\\someone\\Documents\\project-${n}\\a-very-long-file-name-${n}.docx`
  const runs = [
    episode({ id: 'a', tools: TOOLS, varying: { 1: { text: long(1) } } }),
    episode({ id: 'b', tools: TOOLS, varying: { 1: { text: long(2) } } }),
    episode({ id: 'c', tools: TOOLS, varying: { 1: { text: long(3) } } }),
  ]
  assert.deepEqual(extractParams(runs), [], '差异过大就别猜参数')
})

test('draft title prefers the recorded intent', () => {
  const runs = [
    episode({ id: 'a', tools: TOOLS, intent: '订阅一个邮件通讯' }),
    episode({ id: 'b', tools: TOOLS, intent: '订阅一个邮件通讯' }),
    episode({ id: 'c', tools: TOOLS, intent: '订阅一个邮件通讯' }),
  ]
  const draft = compileSkill({ shape: episodeShape(runs[0]), episodes: runs })
  assert.equal(draft.title, '订阅一个邮件通讯')
})
