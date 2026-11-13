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
  console.log('  node bin/he-server.js confirm <工具>  给破坏性动作一次性授权（等价面板按钮）')
  console.log('  node bin/he-server.js export <文件> [--include-logs]  打包技能/目标/卡片')
  console.log('  node bin/he-server.js import <文件> [--dry-run] [--force]  恢复打包')
  console.log('  node bin/he-server.js skill export <id> --to <目录>  导出成 SKILL.md')
  console.log('  node bin/he-server.js skill import <目录>           从 SKILL.md 导入')
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

if (cmd === 'confirm') {
  // 给 MCP / 无面板场景用：允许某一个工具的下一次调用
  if (!arg) { console.error('用法：node bin/he-server.js confirm <工具名>'); process.exit(2) }
  const rt = core.runtime
  if (!rt || typeof rt.grantConfirm !== 'function') {
    console.error('失败：这个运行时没有确认通道')
    process.exit(1)
  }
  const granted = rt.grantConfirm(arg)
  console.log(`已允许一次：${granted.tool}（有效期到 ${granted.expiresAt}）`)
  console.log('下一次调用它会放行；之后再调用仍然会被拦。')
  process.exit(0)
}

if (cmd === 'export') {
  const { exportBundle } = await import('../src/data/bundle.js')
  const { writeFileSync: writeF } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  if (!arg) { console.error('用法：node bin/he-server.js export <文件> [--include-logs]'); process.exit(2) }
  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  const { bundle, counts, warnings } = exportBundle({ dataDir, includeLogs: process.argv.includes('--include-logs') })
  writeF(arg, JSON.stringify(bundle, null, 2), 'utf8')
  console.log(`已打包 -> ${arg}`)
  console.log(`  技能 ${counts.skills} · 目标 ${counts.goals} · 卡片 ${counts.cards}${counts.logs ? ` · 日志 ${counts.logs}` : ''}`)
  for (const w of warnings) console.log('  ⚠ ' + w)
  process.exit(0)
}

if (cmd === 'import') {
  const { importBundle } = await import('../src/data/bundle.js')
  const { readFileSync: readF } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  if (!arg) { console.error('用法：node bin/he-server.js import <文件> [--dry-run] [--force]'); process.exit(2) }
  let bundle
  try {
    bundle = JSON.parse(readF(arg, 'utf8'))
  } catch (e) {
    console.error('失败：不是合法 JSON —— ' + (e instanceof Error ? e.message : String(e)))
    process.exit(2)
  }
  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  const result = await importBundle({
    dataDir,
    bundle,
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force'),
  })
  if (!result.ok) {
    console.error('失败：这次导入没有改动任何数据')
    for (const e of result.errors.slice(0, 8)) console.error('  - ' + e)
    process.exit(1)
  }
  const label = process.argv.includes('--dry-run') ? '（预演，没有写盘）' : ''
  const summarize = (list) => {
    const counts = { add: 0, skip: 0, overwrite: 0 }
    for (const item of list) counts[item.state] += 1
    return `新增 ${counts.add} · 跳过 ${counts.skip} · 覆盖 ${counts.overwrite}`
  }
  console.log('导入计划' + label + '：')
  console.log('  技能 ' + summarize(result.plan.skills))
  console.log('  目标 ' + summarize(result.plan.goals))
  console.log('  卡片 ' + summarize(result.plan.cards))
  if (result.applied) console.log(`已写入：技能 ${result.applied.skills} · 目标 ${result.applied.goals} · 卡片 ${result.applied.cards}`)
  for (const w of result.warnings ?? []) console.log('  ⚠ ' + w)
  process.exit(0)
}

if (cmd === 'skill') {
  const { exportSkillMarkdown, importSkillMarkdown } = await import('../src/skills/skillmd.js')
  const { createSkillStore } = await import('../src/memory/skillStore.js')
  const { copyFileSync, mkdirSync, readFileSync: readF, writeFileSync: writeF, existsSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  const store = createSkillStore({ dir: dataDir })

  const toIndex = process.argv.indexOf('--to')
  const target = toIndex > 0 ? process.argv[toIndex + 1] : null
  const [sub, arg2] = [arg, rawJson]

  if (sub === 'export') {
    if (!arg2 || !target) { console.error('用法：node bin/he-server.js skill export <id> --to <目录>'); process.exit(2) }
    const found = await store.get(arg2)
    if (!found.ok) { console.error('失败：' + found.message); process.exit(1) }
    const out = exportSkillMarkdown(found.value)
    mkdirSync(target, { recursive: true })
    for (const file of out.files) {
      const dest = path.join(target, file.path)
      mkdirSync(path.dirname(dest), { recursive: true })
      if (file.from) {
        if (!existsSync(file.from)) { console.error('警告：找不到脚本 ' + file.from + '，已跳过'); continue }
        copyFileSync(file.from, dest)
      } else {
        writeF(dest, file.content, 'utf8')
      }
    }
    console.log(`已导出「${found.value.title}」-> ${target}`)
    console.log('  name: ' + out.name)
    for (const file of out.files) console.log('  ' + file.path)
    for (const w of out.warnings) console.log('  ⚠ ' + w)
    process.exit(0)
  }

  if (sub === 'import') {
    if (!arg2) { console.error('用法：node bin/he-server.js skill import <目录>'); process.exit(2) }
    const file = path.join(arg2, 'SKILL.md')
    if (!existsSync(file)) { console.error('失败：' + file + ' 不存在'); process.exit(1) }
    const parsed = importSkillMarkdown(readF(file, 'utf8'))
    if (!parsed.ok) { console.error('失败：' + parsed.error); process.exit(1) }
    const saved = await store.save(parsed.skill)
    if (!saved.ok) { console.error('失败：' + saved.message); process.exit(1) }
    console.log(`已导入「${saved.value.title}」-> ${saved.value.id}（${saved.value.steps.length} 步）`)
    for (const w of parsed.warnings) console.log('  ⚠ ' + w)
    process.exit(0)
  }

  console.error('未知子命令：' + sub + '（可用 export / import）')
  process.exit(2)
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
