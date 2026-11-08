#!/usr/bin/env node
// 独立命令行：证明"核心不依赖 DSH 也能跑"。
//
//   node bin/he-server.js list
//   node bin/he-server.js call desk_windows
//   node bin/he-server.js call eye_text '{"text":"..."}'
//
// 走的是同一个 headless 启动 + 同一个 toolServer.callTool —— 门卫照样生效，
// 也就是说 CLI、MCP、插件三处的拦截行为来自同一份代码。

import { bootHeadless } from '../src/server/headless.js'

const [cmd, arg, rawJson] = process.argv.slice(2)
const core = await bootHeadless()

function usage() {
  console.log('用法：')
  console.log('  node bin/he-server.js list                 列出可用工具')
  console.log('  node bin/he-server.js call <工具> [JSON]   调用一个工具')
  console.log('共 ' + core.tools.length + ' 个工具')
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage()
  process.exit(0)
}

if (cmd === 'list') {
  for (const t of core.listTools()) {
    const first = String(t.description || '').split('\n')[0].slice(0, 70)
    console.log(`${t.name.padEnd(18)} ${first}`)
  }
  console.log(`\n共 ${core.tools.length} 个工具`)
  process.exit(0)
}

if (cmd === 'call') {
  if (!arg) {
    usage()
    process.exit(2)
  }
  let args = {}
  if (rawJson) {
    try {
      args = JSON.parse(rawJson)
    } catch (e) {
      console.error('失败：第二个参数必须是合法 JSON —— ' + (e instanceof Error ? e.message : String(e)))
      process.exit(2)
    }
  }
  const result = await core.callTool(arg, args)
  console.log(result.text)
  // 门卫拒绝与工具失败都用非零退出码，方便脚本判断
  process.exit(result.ok ? 0 : 1)
}

usage()
process.exit(2)
