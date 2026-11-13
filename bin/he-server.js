#!/usr/bin/env node
// 独立命令行：证明"核心不依赖 DSH 也能跑"。
//
//   node bin/he-server.js list
//   node bin/he-server.js call desk_windows
//   node bin/he-server.js call eye_text '{"text":"..."}'
//
// 走的是同一个 headless 启动 + 同一个 toolServer.callTool —— 门卫照样生效，
// 也就是说 CLI、MCP、插件三处的拦截行为来自同一份代码。

import { readFileSync } from 'node:fs'

import { bootHeadless } from '../src/server/headless.js'

const [cmd, arg, rawJson] = process.argv.slice(2)
const core = await bootHeadless()

function usage() {
  console.log('用法：')
  console.log('  node bin/he-server.js list                 列出可用工具')
  console.log('  node bin/he-server.js call <工具> [JSON]   调用一个工具')
  console.log('  node bin/he-server.js skills [--min N]      从历史里编译技能草案')
  console.log('  node bin/he-server.js pack validate <目录>  校验一个领域包')
  console.log('  node bin/he-server.js pack install <目录>   安装领域包（卡片进本地库）')
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

if (cmd === 'pack') {
  const { loadPack, installPack } = await import('../src/packs/loader.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const [sub, dir] = [arg, rawJson] // pack <sub> <dir>
  if (!sub || !dir) {
    console.error('用法：node bin/he-server.js pack validate|install <目录>')
    process.exit(2)
  }
  if (sub === 'validate') {
    const loaded = loadPack(dir)
    if (!loaded.ok) {
      console.error('失败：' + loaded.message)
      process.exit(1)
    }
    const pack = loaded.value.pack
    console.log(`通过：${pack.name} v${pack.version} · ${(pack.cards ?? []).length} 张卡片 · ${(pack.verify ?? []).length} 条判据模板`)
    process.exit(0)
  }
  if (sub === 'install') {
    const { createCardStore } = await import('../src/memory/cards.js')
    const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
    const cards = createCardStore({ dir: dataDir })
    const result = await installPack(dir, { cards })
    if (!result.ok) {
      console.error('失败：' + result.message)
      process.exit(1)
    }
    const r = result.value
    console.log(`领域包 ${r.pack.name} v${r.pack.version}：装了 ${r.installed.length} 张卡片，${r.failed.length} 张失败`)
    for (const c of r.installed) console.log('  ✓ ' + c.id + '  ' + c.title)
    for (const f of r.failed) console.log('  × ' + f.id + '  ' + f.message)
    process.exit(r.failed.length ? 1 : 0)
  }
  console.error('未知子命令：' + sub)
  process.exit(2)
}

if (cmd === 'skills') {
  const { createEpisodeStore } = await import('../src/memory/episodes.js')
  const { compileSkills } = await import('../src/memory/skills.js')
  const os = await import('node:os')
  const path = await import('node:path')

  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  const store = createEpisodeStore({ dir: dataDir })
  const listed = await store.list({ limit: 200 })
  if (!listed.ok) {
    console.error('失败：读不到 episode —— ' + listed.message)
    process.exit(1)
  }
  const episodes = listed.value ?? []
  const minIndex = process.argv.indexOf('--min')
  const minRuns = minIndex > 0 ? Math.max(1, Number(process.argv[minIndex + 1]) || 3) : 3

  const drafts = compileSkills(episodes, { minRuns })
  const saveIndex = process.argv.indexOf('--save')
  const shouldSave = saveIndex > 0
  let skillStore = null
  if (shouldSave) {
    const { createSkillStore } = await import('../src/memory/skillStore.js')
    skillStore = createSkillStore({ dir: dataDir })
  }
  console.log(`扫了 ${episodes.length} 条 episode，同类出现 ≥${minRuns} 次的技能草案：${drafts.length} 份\n`)
  for (const draft of drafts) {
    console.log(`【${draft.title}】${draft.id}`)
    console.log(`  来自 ${draft.origin.episodeIds.length} 次运行 · ${draft.steps.length} 步 · 参数 ${draft.params.length} 个`)
    if (draft.incomplete.stepsWithoutChecks > 0) console.log(`  ⚠ ${draft.incomplete.stepsWithoutChecks} 步没有判据（草案不完整，不能直接当"验过了"）`)
    if (draft.incomplete.fragileSteps > 0) console.log(`  ⚠ ${draft.incomplete.fragileSteps} 步只记到坐标/窗口（换屏幕可能失效）`)
    for (const step of draft.steps.slice(0, 6)) {
      const frag = step.anchor && step.anchor.fragile ? '  [脆弱]' : ''
      console.log(`   ${step.id} ${step.intent}${frag}`)
    }
    if (draft.steps.length > 6) console.log(`   … 还有 ${draft.steps.length - 6} 步`)
    console.log('')
  }
  if (shouldSave && drafts.length) {
    let saved = 0
    for (const draft of drafts) {
      const r = await skillStore.save(draft)
      if (r.ok) saved += 1
      else console.error('失败：' + (r.message ?? '保存失败'))
    }
    console.log(`已存入技能库 ${saved} 份 -> ${skillStore.dir}`)
  }
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
      // Windows 上 PowerShell 会吃掉内层双引号，所以支持 @文件 传参：
      //   node bin/he-server.js call skill_use @args.json
      const source = rawJson.startsWith('@') ? readFileSync(rawJson.slice(1), 'utf8') : rawJson
      args = JSON.parse(source)
    } catch (e) {
      console.error('失败：参数必须是合法 JSON（或 @文件）—— ' + (e instanceof Error ? e.message : String(e)))
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
