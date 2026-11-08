#!/usr/bin/env node
// 把格式仓的 schema 与校验器同步进插件。
//
//   node tools/sync-formats.mjs [--formats <路径>]
//
// 默认去找同级的 ../dsh-handeye-formats。同步完顺手比对 FORMATS_VERSION，
// 版本对不上就报错 —— 插件和格式必须说同一版。

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const argIndex = process.argv.indexOf('--formats')
const formatsRoot =
  argIndex > 0 ? process.argv[argIndex + 1] : path.join(path.dirname(repoRoot), 'dsh-handeye-formats')

const schemaDir = path.join(formatsRoot, 'schemas')
const targetSchemas = path.join(repoRoot, 'src', 'formats', 'schemas')
mkdirSync(targetSchemas, { recursive: true })

for (const name of ['skill.schema.json', 'verify.schema.json', 'domain-pack.schema.json']) {
  copyFileSync(path.join(schemaDir, name), path.join(targetSchemas, name))
  console.log('  synced', name)
}
copyFileSync(path.join(formatsRoot, 'lib', 'validate.mjs'), path.join(repoRoot, 'src', 'formats', 'validate.js'))
console.log('  synced validate.js')

const formatsVersion = JSON.parse(readFileSync(path.join(formatsRoot, 'package.json'), 'utf8')).version
const indexText = readFileSync(path.join(repoRoot, 'src', 'formats', 'index.js'), 'utf8')
const match = /FORMATS_VERSION = '([^']+)'/.exec(indexText)
const pluginVersion = match ? match[1] : '(missing)'
if (pluginVersion !== formatsVersion) {
  console.error(`\n失败：格式仓是 ${formatsVersion}，插件写的是 ${pluginVersion}。改 src/formats/index.js 再说。`)
  process.exit(1)
}
console.log(`\nOK：两边都是 FORMATS_VERSION ${pluginVersion}`)
