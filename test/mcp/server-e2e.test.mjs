// 真进程端到端：这条测试存在的原因，是它抓到过一个死锁。
//
// 2026-11-13：服务端发 elicitation 后等宿主回包，而回包被排进了同一条串行队列 ——
// 自己等自己，永远不出结果。单测（直接调 handler）发现不了，只有起真进程才看得见。

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 一次性授权是落盘的：每个用例开跑前必须清掉，否则上一个用例的票会放行下一个
function clearGrantTicket() {
  const file = path.join(process.env.LOCALAPPDATA || tmpdir(), 'dsh-handeye-plus', 'grant-once.json')
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(file, { force: true })
    } catch {}
  }
}

const SERVER = fileURLToPath(new URL('../../src/mcp/server.js', import.meta.url))

function startHost({ elicitation }) {
  clearGrantTicket()
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  const rl = readline.createInterface({ input: child.stdout })
  const events = { elicitation: 0, results: new Map() }
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')

  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method === 'elicitation/create') {
      events.elicitation += 1
      send({ jsonrpc: '2.0', id: msg.id, result: { action: elicitation, content: { approve: elicitation === 'accept' } } })
      return
    }
    if (msg.id !== undefined && msg.result !== undefined) events.results.set(msg.id, msg.result)
  })

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: elicitation === 'none' ? {} : { elicitation: {} },
      clientInfo: { name: 'e2e', version: '1' },
    },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return { child, events, send, close: () => child.kill() }
}

function waitFor(predicate, { timeoutMs = 15000, stepMs = 50 } = {}) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

test('a confirmed destructive action is retried and its real result is returned', async () => {
  const host = startHost({ elicitation: 'accept' })
  try {
    await waitFor(() => host.events.results.has(1))
    host.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com/删除' } } })
    await waitFor(() => host.events.results.has(2))

    const result = host.events.results.get(2)
    const text = String(result?.content?.[0]?.text ?? '')
    assert.equal(host.events.elicitation, 1, '应当恰好弹一次确认')
    // 只断言"门卫放行了"：这台机器可能真的开着浏览器（导航会成功），
    // 也可能没有（导航会失败）。断言具体结果就会变成依赖环境的脆弱测试。
    assert.doesNotMatch(text, /CONFIRM_REQUIRED/, '确认之后不能再是门卫拒绝')
    assert.doesNotMatch(text, /需要用户确认/, '确认之后不该再要确认')
    assert.ok(text.length > 0)
  } finally {
    host.close()
  }
})

test('a declined destructive action never runs', async () => {
  const host = startHost({ elicitation: 'decline' })
  try {
    await waitFor(() => host.events.results.has(1))
    host.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com/删除' } } })
    await waitFor(() => host.events.results.has(2))

    const result = host.events.results.get(2)
    const text = String(result?.content?.[0]?.text ?? '')
    assert.equal(result.isError, true)
    assert.match(text, /拒绝/)
    assert.doesNotMatch(text, /fetch failed/, '拒绝了就不该真的去执行')
  } finally {
    host.close()
  }
})

test('a host without elicitation support gets the plain refusal', async () => {
  const host = startHost({ elicitation: 'none' })
  try {
    await waitFor(() => host.events.results.has(1))
    host.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com/删除' } } })
    await waitFor(() => host.events.results.has(2))

    const text = String(host.events.results.get(2)?.content?.[0]?.text ?? '')
    assert.equal(host.events.elicitation, 0)
    assert.match(text, /CONFIRM_REQUIRED/)
  } finally {
    host.close()
  }
})
