#!/usr/bin/env node
// 独立命令行：证明"核心不依赖 DSH 也能跑"。
//
//   node bin/he-server.js list
//   node bin/he-server.js call desk_windows
//   node bin/he-server.js call eye_text '{"text":"..."}'
//
// 注意：这里用的是同一个 toolServer.callTool —— 门卫照样生效，
// 也就是说 CLI 和插件的拦截行为是同一份代码，不存在"命令行能绕过"的口子。

import { apply } from '../src/index.js'

function makeHost() {
  const tools = []
  const host = {
    tools: { register: (def) => tools.push(def) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: (fn) => {
      try {
        fn()
      } catch {}
    },
    // 没有 webServer：路由不注册，CLI 不需要
    inject: () => {},
    webServer: { register() {} },
  }
  return { host, tools }
}

const { host, tools } = makeHost()
apply(host)

// 运行时是同步创建的，但 episode prune 之类是异步的，给一点时间
await new Promise((resolve) => setTimeout(resolve, 400))

const byName = new Map(tools.map((t) => [t.name, t]))
const [cmd, arg, rawJson] = process.argv.slice(2)

function usage() {
  console.log('用法：')
  console.log('  node bin/he-server.js list                 列出可用工具')
  console.log('  node bin/he-server.js call <工具> [JSON]   调用一个工具')
  console.log('共 ' + tools.length + ' 个工具')
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  usage()
  process.exit(0)
}

if (cmd === 'list') {
  for (const t of tools) {
    const first = String(t.description || '').split('\n')[0].slice(0, 70)
    console.log(`${t.name.padEnd(18)} ${first}`)
  }
  console.log(`\n共 ${tools.length} 个工具`)
  process.exit(0)
}

if (cmd === 'call') {
  if (!arg) {
    usage()
    process.exit(2)
  }
  const tool = byName.get(arg)
  if (!tool) {
    console.error(`失败：没有这个工具 ${arg}`)
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
  try {
    const out = await tool.execute(args, null)
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
    // 门卫拒绝与工具失败都用非零退出码，方便脚本判断
    const text = typeof out === 'string' ? out : ''
    process.exit(text.startsWith('Refused:') || text.includes('失败：') ? 1 : 0)
  } catch (e) {
    console.error('失败：' + (e instanceof Error ? e.message : String(e)))
    process.exit(1)
  }
}

usage()
process.exit(2)
