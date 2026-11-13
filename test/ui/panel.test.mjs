// 面板文件护栏：结构、日志列、教程、确认区（客户端注册由 client-slot.test.mjs 管）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dashboard = readFileSync(root + 'src/ui/dashboard.html', 'utf8')

test('the panel calls itself 手嘴眼', () => {
  assert.match(dashboard, /<title>手嘴眼/)
  assert.match(dashboard, /<h1>手嘴眼/)
  assert.doesNotMatch(dashboard, /手眼\+/, '旧叫法不该再出现')
})

test('the layout imitates dsh-context: main card column + right sidebar', () => {
  assert.match(dashboard, /class="wrap"/)
  assert.match(dashboard, /class="main"/)
  assert.match(dashboard, /class="aside"/)
  for (const card of ['执行统计', '系统日志', '当前目标', '事件级别分布', '耗时统计', '能力', '任务卡', '插件信息', '技能']) {
    assert.match(dashboard, new RegExp('<h2>' + card), '缺卡片 ' + card)
  }
})

test('the system log is a full-width, tall table', () => {
  // 2026-11-13 用户要求：系统日志占的地方太小 —— 现在整宽、最高 472px
  assert.match(dashboard, /max-height:472px/)
  assert.match(dashboard, /id="log-q"/)
  assert.match(dashboard, /id="log-source"/)
  for (const col of ['级别', '日期和时间', '来源', '事件 ID', '任务类别', '描述']) {
    assert.match(dashboard, new RegExp(col), '缺列 ' + col)
  }
  assert.match(dashboard, /导出 \/ 打开全部/)
})

test('the overview keeps a confirm card for destructive actions', () => {
  assert.match(dashboard, /id="confirm-card"/)
  assert.match(dashboard, /允许一次/)
})

test('the tutorial still exists, as a modal', () => {
  assert.match(dashboard, /id="tut-modal"/)
  assert.match(dashboard, /怎么加一份技能/)
  assert.match(dashboard, /门卫拦住了怎么办/)
})

test('the panel does not hardcode a host or a browser address', () => {
  assert.doesNotMatch(dashboard, /127\.0\.0\.1/)
  assert.match(dashboard, /dsh-handeye-plus/)
})
