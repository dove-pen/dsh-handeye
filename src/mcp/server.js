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
const handle = createMcpHandler({
  listTools: core.listTools,
  callTool: core.callTool,
  info: { name: 'handeye', version: VERSION },
})

log(`ready: ${core.tools.length} tools`)

const rl = createInterface({ input: process.stdin })
let queue = Promise.resolve()

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
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
