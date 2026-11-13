// 界面回归护栏。
//
// 这里不测像素，只测"结构还在不在"：面板文件、页签、叫法、以及旧痕迹有没有残留。
// 2026-11-13 用户要求：对外叫「手嘴眼」、面板做成 DSH 里的整页视图、别再用浏览器单独开。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dashboard = readFileSync(root + 'src/ui/dashboard.html', 'utf8')
const client = readFileSync(root + 'src/client.js', 'utf8')

test('the panel calls itself 手嘴眼', () => {
  assert.match(dashboard, /<title>手嘴眼/)
  assert.match(dashboard, /<h1>手嘴眼/)
  assert.match(client, /手嘴眼/)
  assert.doesNotMatch(client, /手眼\+/, '旧叫法不该再出现在界面上')
})

test('the panel has the five views, including a tutorial', () => {
  for (const view of ['overview', 'log', 'caps', 'cards', 'tutorial']) {
    assert.match(dashboard, new RegExp('data-view="' + view + '"'), '缺页签 ' + view)
    assert.match(dashboard, new RegExp('id="v-' + view + '"'), '缺视图 ' + view)
  }
  assert.match(dashboard, /怎么加一份技能/)
  assert.match(dashboard, /门卫拦住了怎么办/)
})

test('the log table keeps the Windows-style columns', () => {
  for (const col of ['级别', '日期和时间', '来源', '事件 ID', '任务类别', '描述']) {
    assert.match(dashboard, new RegExp(col), '缺列 ' + col)
  }
  assert.match(dashboard, /导出 CSV/)
})

test('the DSH tab opens a full page, not the vertical drawer', () => {
  assert.match(client, /function openBigView\(\)/)
  assert.match(client, /id = 'dsh-he-bigview'/)
  assert.match(client, /dsh-handeye-plus\/dashboard/)
  // 顶部页签的点击必须走大面板
  assert.match(client, /const openPanel = \(event\) => \{[\s\S]{0,200}openBigView\(\)/)
})

test('closing the big view cleans up after itself', () => {
  assert.match(client, /function closeBigView\(\)/)
  assert.match(client, /Escape/)
  assert.match(client, /dsh-he-bigview'\)\s*\n\s*if \(big\) big.remove\(\)/)
})

test('the overview shows a confirm section for destructive actions', () => {
  assert.match(dashboard, /待确认（破坏性动作）/)
  assert.match(dashboard, /允许一次/)
})
