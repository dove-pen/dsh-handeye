// 面板文件护栏：结构、日志列、教程、确认区（客户端注册由 client-slot.test.mjs 管）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dashboard = readFileSync(root + 'src/ui/dashboard.html', 'utf8')

test('the panel is fully English with bright white text', () => {
  assert.match(dashboard, /<title>HandEye/)
  assert.match(dashboard, /<h1>HandEye/)
  // 可见文字里不许再有中文（注释不算）
  const visible = dashboard.split('\n').filter((l) => {
    const t = l.trim()
    // 注释、以及"中文数据 -> 英文"的映射表不算可见文字
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')) return false
    if (/_EN\s*=|SOURCE_EN|CATEGORY_EN/.test(l)) return false
    // 去掉 "'中文': 'English'" 这种映射对再看剩下的中文
    const stripped = l.replace(/'[^']*'\s*:\s*'[^']*'/g, '')
    return /[\u4e00-\u9fa5]/.test(stripped)
  })
  assert.equal(visible.length, 0, '还有中文：' + visible.slice(0, 3).join(' | '))
  assert.match(dashboard, /--text: #ffffff/)
})

test('the layout imitates dsh-context: main card column + right sidebar', () => {
  assert.match(dashboard, /class="wrap"/)
  assert.match(dashboard, /class="main"/)
  assert.match(dashboard, /class="aside"/)
  for (const card of ['Execution', 'System log', 'Current goal', 'Severity mix', 'Timing', 'Capabilities', 'Cards', 'Plugin', 'Skills']) {
    assert.match(dashboard, new RegExp('<h2>' + card), '缺卡片 ' + card)
  }
})

test('the system log is a full-width, tall table', () => {
  // 2026-11-13 用户要求：系统日志占的地方太小 —— 现在整宽、最高 472px
  assert.match(dashboard, /max-height:472px/)
  assert.match(dashboard, /id="log-q"/)
  assert.match(dashboard, /id="log-source"/)
  for (const col of ['Level', 'Date and time', 'Source', 'Event ID', 'Category', 'Message']) {
    assert.match(dashboard, new RegExp(col), '缺列 ' + col)
  }
  assert.match(dashboard, /Export \/ Open all/)
})

test('the overview keeps a confirm card for destructive actions', () => {
  assert.match(dashboard, /id="confirm-card"/)
  assert.match(dashboard, /Allow once/)
})

test('the tutorial still exists, as a modal', () => {
  assert.match(dashboard, /id="tut-modal"/)
  assert.match(dashboard, /Adding a skill/)
  assert.match(dashboard, /When the gate refuses/)
})

test('the panel does not hardcode a host or a browser address', () => {
  assert.doesNotMatch(dashboard, /127\.0\.0\.1/)
  assert.match(dashboard, /dsh-handeye-plus/)
})

test('the panel can write and run tutorials', () => {
  assert.match(dashboard, /id="tutorial-card"/)
  assert.match(dashboard, /New tutorial/)
  assert.match(dashboard, /id="tut-path"/)
  assert.match(dashboard, /id="tut-save"/)
  assert.match(dashboard, /tutorials\/run/)
})
