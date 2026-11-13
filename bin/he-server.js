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
  console.log('Usage:')
  console.log('  node bin/he-server.js list                 list available tools')
  console.log('  node bin/he-server.js call <tool> [JSON]   call one tool')
  console.log('  node bin/he-server.js skills [--min N]      compile skill drafts from history')
  console.log('  node bin/he-server.js confirm <tool>  grant a destructive action once (same as the panel button)')
  console.log('  node bin/he-server.js export <file> [--include-logs]  pack skills/goals/cards')
  console.log('  node bin/he-server.js import <file> [--dry-run] [--force]  restore a pack')
  console.log('  node bin/he-server.js skill export <id> --to <dir>  export as SKILL.md')
  console.log('  node bin/he-server.js skill import <dir>           import from SKILL.md')
  console.log('  node bin/he-server.js pack validate <dir>  validate a domain pack')
  console.log('  node bin/he-server.js pack install <dir>   install a domain pack (cards into the store)')
  console.log(core.tools.length + ' tools')
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
  console.log(`\n${core.tools.length} tools`)
  process.exit(0)
}

if (cmd === 'confirm') {
  // 给 MCP / 无面板场景用：允许某一个工具的下一次调用
  if (!arg) { console.error('usage: node bin/he-server.js confirm <tool>'); process.exit(2) }
  const rt = core.runtime
  if (!rt || typeof rt.grantConfirm !== 'function') {
    console.error('Failed: this runtime has no confirmation channel')
    process.exit(1)
  }
  const granted = rt.grantConfirm(arg)
  console.log(`allowed once: ${granted.tool} (valid until ${granted.expiresAt})`)
  console.log('the next call is allowed; calls after that are still blocked.')
  process.exit(0)
}

if (cmd === 'export') {
  const { exportBundle } = await import('../src/data/bundle.js')
  const { writeFileSync: writeF } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  if (!arg) { console.error('usage: node bin/he-server.js export <file> [--include-logs]'); process.exit(2) }
  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  const { bundle, counts, warnings } = exportBundle({ dataDir, includeLogs: process.argv.includes('--include-logs') })
  writeF(arg, JSON.stringify(bundle, null, 2), 'utf8')
  console.log(`packed -> ${arg}`)
  console.log(`  skills ${counts.skills} · goals ${counts.goals} · cards ${counts.cards}${counts.logs ? ` · logs ${counts.logs}` : ''}`)
  for (const w of warnings) console.log('  ⚠ ' + w)
  process.exit(0)
}

if (cmd === 'import') {
  const { importBundle } = await import('../src/data/bundle.js')
  const { readFileSync: readF } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  if (!arg) { console.error('usage: node bin/he-server.js import <file> [--dry-run] [--force]'); process.exit(2) }
  let bundle
  try {
    bundle = JSON.parse(readF(arg, 'utf8'))
  } catch (e) {
    console.error('Failed: not valid JSON - ' + (e instanceof Error ? e.message : String(e)))
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
    console.error('Failed: the import changed nothing')
    for (const e of result.errors.slice(0, 8)) console.error('  - ' + e)
    process.exit(1)
  }
  const label = process.argv.includes('--dry-run') ? ' (dry run, nothing written)' : ''
  const summarize = (list) => {
    const counts = { add: 0, skip: 0, overwrite: 0 }
    for (const item of list) counts[item.state] += 1
    return `new ${counts.add} · skipped ${counts.skip} · overwritten ${counts.overwrite}`
  }
  console.log('import plan' + label + ':')
  console.log('  skills ' + summarize(result.plan.skills))
  console.log('  goals ' + summarize(result.plan.goals))
  console.log('  cards ' + summarize(result.plan.cards))
  if (result.applied) console.log(`written: skills ${result.applied.skills} · goals ${result.applied.goals} · cards ${result.applied.cards}`)
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
    if (!arg2 || !target) { console.error('usage: node bin/he-server.js skill export <id> --to <dir>'); process.exit(2) }
    const found = await store.get(arg2)
    if (!found.ok) { console.error('Failed: ' + found.message); process.exit(1) }
    const out = exportSkillMarkdown(found.value)
    mkdirSync(target, { recursive: true })
    for (const file of out.files) {
      const dest = path.join(target, file.path)
      mkdirSync(path.dirname(dest), { recursive: true })
      if (file.from) {
        if (!existsSync(file.from)) { console.error('warning: script not found: ' + file.from + ' (skipped)'); continue }
        copyFileSync(file.from, dest)
      } else {
        writeF(dest, file.content, 'utf8')
      }
    }
    console.log(`exported "${found.value.title}" -> ${target}`)
    console.log('  name: ' + out.name)
    for (const file of out.files) console.log('  ' + file.path)
    for (const w of out.warnings) console.log('  ⚠ ' + w)
    process.exit(0)
  }

  if (sub === 'import') {
    if (!arg2) { console.error('usage: node bin/he-server.js skill import <dir>'); process.exit(2) }
    const file = path.join(arg2, 'SKILL.md')
    if (!existsSync(file)) { console.error('Failed: ' + file + ' does not exist'); process.exit(1) }
    const parsed = importSkillMarkdown(readF(file, 'utf8'))
    if (!parsed.ok) { console.error('Failed: ' + parsed.error); process.exit(1) }
    const saved = await store.save(parsed.skill)
    if (!saved.ok) { console.error('Failed: ' + saved.message); process.exit(1) }
    console.log(`imported "${saved.value.title}" -> ${saved.value.id} (${saved.value.steps.length} steps)`)
    for (const w of parsed.warnings) console.log('  ⚠ ' + w)
    process.exit(0)
  }

  console.error('unknown subcommand: ' + sub + ' (available: export / import)')
  process.exit(2)
}

if (cmd === 'pack') {
  const { loadPack, installPack } = await import('../src/packs/loader.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const [sub, dir] = [arg, rawJson] // pack <sub> <dir>
  if (!sub || !dir) {
    console.error('usage: node bin/he-server.js pack validate|install <dir>')
    process.exit(2)
  }
  if (sub === 'validate') {
    const loaded = loadPack(dir)
    if (!loaded.ok) {
      console.error('Failed: ' + loaded.message)
      process.exit(1)
    }
    const pack = loaded.value.pack
    console.log(`ok: ${pack.name} v${pack.version} · ${(pack.cards ?? []).length} cards · ${(pack.verify ?? []).length} check templates`)
    process.exit(0)
  }
  if (sub === 'install') {
    const { createCardStore } = await import('../src/memory/cards.js')
    const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
    const cards = createCardStore({ dir: dataDir })
    const result = await installPack(dir, { cards })
    if (!result.ok) {
      console.error('Failed: ' + result.message)
      process.exit(1)
    }
    const r = result.value
    console.log(`pack ${r.pack.name} v${r.pack.version}: installed ${r.installed.length} cards, ${r.failed.length} failed`)
    for (const c of r.installed) console.log('  ✓ ' + c.id + '  ' + c.title)
    for (const f of r.failed) console.log('  × ' + f.id + '  ' + f.message)
    process.exit(r.failed.length ? 1 : 0)
  }
  console.error('unknown subcommand: ' + sub)
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
    console.error('Failed: could not read episodes - ' + listed.message)
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
  console.log(`scanned ${episodes.length} episodes; drafts for groups seen >=${minRuns} times: ${drafts.length}\n`)
  for (const draft of drafts) {
    console.log(`【${draft.title}】${draft.id}`)
    console.log(`  from ${draft.origin.episodeIds.length} runs · ${draft.steps.length} steps · ${draft.params.length} params`)
    if (draft.incomplete.stepsWithoutChecks > 0) console.log(`  ⚠ ${draft.incomplete.stepsWithoutChecks} 步没有判据（草案不完整，不能直接当"验过了"）`)
    if (draft.incomplete.fragileSteps > 0) console.log(`  ! ${draft.incomplete.fragileSteps} steps only recorded coordinates/windows (may break elsewhere)`)
    for (const step of draft.steps.slice(0, 6)) {
      const frag = step.anchor && step.anchor.fragile ? '  [fragile]' : ''
      console.log(`   ${step.id} ${step.intent}${frag}`)
    }
    if (draft.steps.length > 6) console.log(`   ... ${draft.steps.length - 6} more steps`)
    console.log('')
  }
  if (shouldSave && drafts.length) {
    let saved = 0
    for (const draft of drafts) {
      const r = await skillStore.save(draft)
      if (r.ok) saved += 1
      else console.error('Failed: ' + (r.message ?? 'could not save'))
    }
    console.log(`saved ${saved} skills -> ${skillStore.dir}`)
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
      let source = rawJson.startsWith('@') ? readFileSync(rawJson.slice(1), 'utf8') : rawJson
      // PowerShell 的 UTF8 会带 BOM，strip 掉再解析
      if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
      args = JSON.parse(source.trim())
    } catch (e) {
      console.error('Failed: arguments must be valid JSON (or @file) - ' + (e instanceof Error ? e.message : String(e)))
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
