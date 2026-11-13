// 面板文件护栏：结构、日志列、教程、确认区（客户端注册由 client-slot.test.mjs 管）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dashboard = readFileSync(root + 'src/ui/dashboard.html', 'utf8')

test('the panel defaults to English with bright white text', () => {
  assert.match(dashboard, /<title>HandEye/)
  assert.match(dashboard, /<h1>HandEye/)
  assert.match(dashboard, /--text: #ffffff/)
  // 语言/字号控件与中文词表是"国际化机制"，不算可见英文文案
  const stripped = dashboard
    .replace(/const ZH = \{[\s\S]*?\n\}/, '')
    .split('\n')
    .filter((l) => !/id="lang"|id="fontsize"|value="zh">中文/.test(l))
    .filter((l) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')) return false
      if (/_EN\s*=|SOURCE_EN|CATEGORY_EN/.test(l)) return false
      return true
    })
    .join('\n')
  const visible = stripped.split('\n').filter((l) => {
    const withoutPairs = l.replace(/'[^']*'\s*:\s*'[^']*'/g, '')
    return /[\u4e00-\u9fa5]/.test(withoutPairs)
  })
  assert.equal(visible.length, 0, '还有中文：' + visible.slice(0, 3).join(' | '))
})


test('the user can change font size', () => {
  assert.match(dashboard, /id="fontsize"/)
  assert.match(dashboard, /localStorage.setItem\('he.size'/)
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

test('counts use singular/plural correctly', () => {
  assert.match(dashboard, /function plural\(/)
  assert.doesNotMatch(dashboard, /length \+ ' skills'/, "不许再出现 \"1 skills\"")
  assert.match(dashboard, /plural\(skills\.length, 'skill', 'skills'\)/)
})

test('confirm dialog serializes object args instead of [object Object]', () => {
  assert.doesNotMatch(dashboard, /String\(p\.args \.\|\| ''\)/)
  assert.match(dashboard, /JSON\.stringify\(p \?\? \{\}\)/)
})

test('timing counts every action, not only ones with an ms field', () => {
  assert.match(dashboard, /e\.eventId === 4001 \|\| e\.eventId === 4002/)
})

test('the panel is English only — no language switcher', () => {
  assert.doesNotMatch(dashboard, /id="lang"/, '不该再有语言选择器')
  assert.doesNotMatch(dashboard, /const ZH = \{/, '不该再有中文词表')
  assert.doesNotMatch(dashboard, /he\.lang/)
})

test('adds a little motion but respects reduced motion', () => {
  assert.match(dashboard, /@keyframes he-card-in/)
  assert.match(dashboard, /prefers-reduced-motion: reduce/)
  assert.match(dashboard, /.card \{ animation: he-card-in/)
})
