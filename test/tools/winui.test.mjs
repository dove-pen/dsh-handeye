import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveTarget,
  describeWindow,
  pickWindowByTitle,
  formatClickResult,
  clampScale,
  parseRegion,
  grabRegion,
  cropRegion,
  WinUiError,
} from '../../src/winui.js'

test('resolveTarget: hwnd wins, title is the fallback, nothing means nothing', () => {
  assert.deepEqual(resolveTarget({ hwnd: 42 }), { hwnd: 42 })
  assert.deepEqual(resolveTarget({ hwnd: '42' }), { hwnd: 42 })
  assert.deepEqual(resolveTarget({ title: '  记事本  ' }), { title: '记事本' })
  assert.deepEqual(resolveTarget({ hwnd: 42, title: 'ignored' }), { hwnd: 42 })
  assert.equal(resolveTarget({}), null)
  assert.equal(resolveTarget(), null)
  assert.equal(resolveTarget({ hwnd: 0 }), null)
  assert.equal(resolveTarget({ hwnd: -5 }), null)
  assert.equal(resolveTarget({ title: '   ' }), null)
})

test('describeWindow renders a stable one-liner', () => {
  const text = describeWindow({ title: 'Outlook', hwnd: 7, className: 'Chrome_WidgetWin_1', minimized: true })
  assert.match(text, /"Outlook"/)
  assert.match(text, /hwnd=7/)
  assert.match(text, /Chrome_WidgetWin_1/)
  assert.match(text, /最小化/)
  assert.equal(describeWindow(null), '（没有窗口）')
  assert.match(describeWindow({ hwnd: 1 }), /（无标题）/)
})

test('pickWindowByTitle prefers exact, then prefix, then substring', () => {
  const wins = [
    { hwnd: 1, title: 'Chrome - 新闻实验室' },
    { hwnd: 2, title: '新闻实验室 Newsletter' },
    { hwnd: 3, title: '新闻实验室 Newsletter - Chrome' },
  ]
  assert.equal(pickWindowByTitle(wins, '新闻实验室 Newsletter').hwnd, 2)
  assert.equal(pickWindowByTitle(wins, 'chrome - 新闻').hwnd, 1)
  assert.equal(pickWindowByTitle(wins, '新闻实验室').hwnd, 2)
  assert.equal(pickWindowByTitle(wins, '不存在'), null)
  assert.equal(pickWindowByTitle(null, 'x'), null)
  assert.equal(pickWindowByTitle(wins, ''), null)
})

test('pickWindowByTitle breaks ties by minimized then foreground then order', () => {
  const wins = [
    { hwnd: 1, title: 'Target', minimized: true, foreground: false },
    { hwnd: 2, title: 'Target', minimized: false, foreground: false },
    { hwnd: 3, title: 'Target', minimized: false, foreground: true },
  ]
  assert.equal(pickWindowByTitle(wins, 'Target').hwnd, 3)
  const sameScore = [
    { hwnd: 10, title: 'Target' },
    { hwnd: 11, title: 'Target' },
  ]
  assert.equal(pickWindowByTitle(sameScore, 'Target').hwnd, 10)
})

test('formatClickResult says whether the mouse was really pressed', () => {
  const real = formatClickResult({
    ok: true,
    x: 600,
    y: 400,
    hit: { title: 'Outlook', hwnd: 9 },
    target: { title: 'Outlook', hwnd: 9 },
    foreground: { title: 'Outlook', hwnd: 9 },
    attempts: 1,
  })
  assert.match(real, /已点击 \(600,400\)/)
  assert.match(real, /命中窗口/)
  assert.doesNotMatch(real, /预演/)

  const dry = formatClickResult({ ok: true, dryRun: true, x: 1, y: 2, hit: { title: 'X', hwnd: 1 } })
  assert.match(dry, /预演通过/)

  const retried = formatClickResult({ ok: true, x: 1, y: 2, attempts: 4, hit: { title: 'X', hwnd: 1 } })
  assert.match(retried, /重新聚焦 4 次/)

  assert.equal(formatClickResult(null), '点击没有执行。')
})

test('formatClickResult mentions right button and double click', () => {
  const text = formatClickResult({ ok: true, x: 5, y: 6, button: 'right', double: true, hit: { title: 'X', hwnd: 1 } })
  assert.match(text, /右键/)
  assert.match(text, /双击/)
})

test('clampScale keeps the crop inside 1..8 and survives junk', () => {
  assert.equal(clampScale(3), 3)
  assert.equal(clampScale(0), 1)
  assert.equal(clampScale(99), 8)
  assert.equal(clampScale(2.6), 3)
  assert.equal(clampScale('4'), 4)
  assert.equal(clampScale(undefined), 3)
  assert.equal(clampScale('abc', 2), 2)
})

test('parseRegion accepts commas, spaces and full-width commas', () => {
  assert.deepEqual(parseRegion('700,348,400,40'), { x: 700, y: 348, w: 400, h: 40 })
  assert.deepEqual(parseRegion('700 348 400 40'), { x: 700, y: 348, w: 400, h: 40 })
  assert.deepEqual(parseRegion('700，348，400，40'), { x: 700, y: 348, w: 400, h: 40 })
  assert.deepEqual(parseRegion('700, 348 , 400,40'), { x: 700, y: 348, w: 400, h: 40 })
  assert.equal(parseRegion('1,2,3'), null)
  assert.equal(parseRegion('1,2,0,40'), null)
  assert.equal(parseRegion('1,2,-3,40'), null)
  assert.equal(parseRegion('a,b,c,d'), null)
  assert.equal(parseRegion(''), null)
})

test('WinUiError carries the machine-readable code and extras', () => {
  const err = new WinUiError('wrong-window', 'nope', { wanted: 1 })
  assert.equal(err.name, 'WinUiError')
  assert.equal(err.code, 'wrong-window')
  assert.deepEqual(err.extra, { wanted: 1 })
  const bare = new WinUiError('x', 'y')
  assert.equal(bare.extra, null)
})

test('grabRegion and cropRegion refuse to run without an output path', async () => {
  await assert.rejects(() => grabRegion({ x: 1, y: 2, w: 3, h: 4 }), (e) => e instanceof WinUiError && e.code === 'bad-args')
  await assert.rejects(() => cropRegion({ source: 'x.png' }), (e) => e instanceof WinUiError && e.code === 'bad-args')
  await assert.rejects(() => cropRegion({ outImage: 'x.png' }), (e) => e instanceof WinUiError && e.code === 'bad-args')
})