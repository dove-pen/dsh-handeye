#!/usr/bin/env node
// MCP server（stdio 传输）。
//
//   node src/mcp/server.js
//
// stdout 只写 JSON-RPC 消息，任何日志都走 stderr —— 否则客户端会解析失败。
// 工具来自 core（toolServer.callTool），所以门卫在这里照样生效：
// Claude / ChatGPT / Cursor 接进来，跟 DSH 面板里是同一道门。

import { createInterface } from 'node:readline'

import { bootHeadless } from '../server/headless.js'
import { createMcpHandler } from './protocol.js'
import { VERSION } from './version.js'

const log = (...args) => process.stderr.write(`[handeye-mcp] ${args.join(' ')}\n`)

const core = await bootHeadless()

// 服务端发起的请求（elicitation）：需要给每个请求一个 id，并等客户端回包。
let nextRequestId = 1000
const pending = new Map()

function sendRequest(method, params) {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`client did not respond to ${method}`))
      }
    }, 120000)
  }).finally(() => pending.delete(id))
}

const handle = createMcpHandler({
  listTools: core.listTools,
  callTool: core.callTool,
  info: { name: 'handeye', version: VERSION },
  request: sendRequest,
  // 用户同意后写一次性授权（单工具、2 分钟、用完即焚）
  grant: (tool) => {
    try {
      return Boolean(core.runtime && typeof core.runtime.grantConfirm === 'function' && core.runtime.grantConfirm(tool))
    } catch {
      return false
    }
  },
})

log(`ready: ${core.tools.length} tools`)

const rl = createInterface({ input: process.stdin })
let queue = Promise.resolve()

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return

  // 🔥 回包必须先于队列处理：队列是串行的，而正在跑的那条 tools/call
  // 可能正在等这个回包（elicitation）。若把回包也排进队列，就是自己等自己 —— 死锁。
  // （2026-11-13 实测踩到：宿主回了确认，服务端却再也不出结果）
  let early = null
  try {
    early = JSON.parse(text)
  } catch {
    early = null
  }
  if (early && early.method === undefined && early.id !== undefined && pending.has(early.id)) {
    const entry = pending.get(early.id)
    pending.delete(early.id)
    if (early.error) entry.reject(new Error(early.error.message || 'client error'))
    else entry.resolve(early.result)
    return
  }

  // 串行处理：工具调用之间可能共享同一套运行时状态，乱序会互相踩
  queue = queue
    .then(async () => {
      let msg
      try {
        msg = JSON.parse(text)
      } catch (error) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        return
      }
      const response = await handle(msg)
      if (response) write(response)
    })
    .catch((error) => {
      log('handler crashed:', error instanceof Error ? error.message : String(error))
    })
})

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

rl.on('close', () => {
  // 必须等队列排空：stdin 一关就 exit，会把还没跑完的工具调用直接掐掉
  // （实测：短管道喂三条消息，最后一条 tools/call 的结果丢失）
  queue
    .then(() => {
      log('stdin closed, queue drained, exiting')
      process.exit(0)
    })
    .catch(() => process.exit(1))
})

process.on('uncaughtException', (error) => {
  log('uncaught:', error instanceof Error ? error.message : String(error))
})
