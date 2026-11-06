// dsh-handeye 投影层单测。
//
// 投影是纯函数、确定性、最能回归的部分：这里只断言"不编造、报警不丢、
// 头行不丢、超预算只砍尾巴"，不测 OCR 本身（那属于 handeye 的 bench）。
//
// 运行：ELECTRON_RUN_AS_NODE=1 "E:\deep sick\DeepSeek Harness.exe" --test test/
// 或者在有 node 的机器上：npm test
import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_L1_CHARS, findAlarms, project, projectL0, projectL1, truncateLines } from '../src/project.js'

function block(kind, items, extra = {}) {
  return {
    kind,
    window: '测试窗口',
    box: { x: 10, y: 10, w: 200, h: 20 },
    items: items.map((text, i) => ({ text, x: 10, y: 10 + i * 20, w: 100, h: 16 })),
    ...extra,
  }
}

function viewOf(blocks, extra = {}) {
  return { screen: { w: 1440, h: 900 }, focus: '演示窗口', rawLines: 60, delta: {}, blocks, ...extra }
}

test('L0：自绘界面报 0 个可点时必须解释原因', () => {
  const view = viewOf([block('content', ['页面正文一']), block('content', ['页面正文二'])])
  const [head] = projectL0(view, [])
  assert.match(head, /^\[L0\]/)
  assert.match(head, /可点 0 项（界面自绘/)
  assert.match(head, /eye_find/)
})

test('L0：有真实按钮时不加自绘提示', () => {
  const view = viewOf([block('button', ['确定']), block('button', ['取消']), block('content', ['正文'])])
  const [head] = projectL0(view, [])
  assert.match(head, /可点 2 项/)
  assert.doesNotMatch(head, /界面自绘/)
})

test('L0：对话框和错误词一定出现在报警行里', () => {
  const view = viewOf([
    block('dialog', ['保存失败：磁盘空间不足'], { window: '另存为' }),
    block('content', ['连接超时，请重试']),
    block('content', ['普通正文不会报警']),
  ])
  const out = projectL0(view, findAlarms(view))
  const alarms = out.filter((l) => l.startsWith('[报警]'))
  assert.ok(alarms.length >= 2, `至少 2 条报警，实际：\n${out.join('\n')}`)
  assert.ok(out.some((l) => l.includes('保存失败')))
  assert.ok(out.some((l) => l.includes('连接超时')))
  assert.ok(!out.some((l) => l.includes('[报警] 错误词「普通正文')))
})

test('L1：超预算时头行和报警不丢，只砍尾部', () => {
  const buttons = []
  for (let i = 0; i < 300; i += 1) buttons.push(block('button', [`按钮编号 ${i}`]))
  buttons.push(block('content', ['网络错误，请检查连接']))
  const view = viewOf(buttons)
  const out = projectL1(view, findAlarms(view))
  const text = out.join('\n')

  assert.match(out[0], /^\[L1\]/, '头行必须在最前面')
  assert.ok(text.length <= MAX_L1_CHARS, `截断后长度 ${text.length} 应不超过预算 ${MAX_L1_CHARS}`)
  assert.ok(out.some((l) => l.startsWith('[报警]') && l.includes('网络错误')), '报警行必须保留')
  assert.match(text, /已按预算截断/)
  assert.ok(out.some((l) => l.includes('按钮编号 0')), '靠前的行应保留')
  assert.ok(!out.some((l) => l.includes('按钮编号 299')), '靠后的行应被砍掉')
})

test('L1：正文按面积从大到小取，主内容区优先于侧栏', () => {
  const small = block('content', ['侧栏小字'])
  small.box = { x: 10, y: 10, w: 60, h: 12 }
  const big = block('content', ['主内容区的大段正文'])
  big.box = { x: 100, y: 100, w: 900, h: 400 }
  const out = projectL1(viewOf([small, big]), [])
  const bigAt = out.findIndex((l) => l.includes('主内容区的大段正文'))
  const smallAt = out.findIndex((l) => l.includes('侧栏小字'))
  assert.ok(bigAt > 0 && smallAt > 0, '两块都应该出现')
  assert.ok(bigAt < smallAt, '大块应排在小块前面')
})

test('truncateLines：预算够时原样返回，不动内容', () => {
  const lines = ['[L1] 头', '[button] 确定 @(10,10)', '[报警] 错误词「失败」@(20,20)']
  assert.deepEqual(truncateLines(lines, 4000), lines)
})

test('truncateLines：报警行比预算还长时也不丢', () => {
  const alarm = '[报警] 错误词「' + '超长错误 '.repeat(600) + '」'
  const lines = ['[L1] 头', alarm, '[button] 确定']
  const out = truncateLines(lines, 200)
  assert.ok(out[0].startsWith('[L1]'))
  assert.ok(out.includes(alarm), '报警行永远不丢')
  assert.ok(out.some((l) => l.includes('已按预算截断')))
})
