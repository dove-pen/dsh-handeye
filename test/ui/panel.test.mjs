// 面板文件的护栏：只检查 dashboard.html 的结构（客户端注册由 client-slot.test.mjs 管）。

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

test('the overview shows a confirm section for destructive actions', () => {
  assert.match(dashboard, /待确认（破坏性动作）/)
  assert.match(dashboard, /允许一次/)
})

test('the panel does not depend on being opened in a separate browser window', () => {
  // iframe 里也要能刷新和暂停轮询；不写死 127.0.0.1
  assert.doesNotMatch(dashboard, /127\.0\.0\.1/)
  assert.match(dashboard, /dsh-handeye-plus/)
})
