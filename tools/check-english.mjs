// 英文闸门：扫 src/ 里**字符串字面量中的中文**（注释不算）。
//
// 用途：
//   1) 平时 → 给出"还剩多少条"的准确进度（我手动数过两次都很容易数错）
//   2) CI 里 --strict → 不允许新增中文，直至全量清零
//
// 用法：
//   node tools/check-english.mjs            # 报告
//   node tools/check-english.mjs --strict   # 有中文就非零退出

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const CJK = /[\u4e00-\u9fa5]/

/** 抽出字符串字面量（'…'、"…"、`…`），跳过注释。 */
export function stringLiterals(source) {
  const out = []
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    // 正则字面量的启发式：斜杠前面是运算符/括号/开头时，跳过整条正则（避免把 /["']/ 当字符串）
    if (ch === '/' && next !== '/' && next !== '*') {
      const prev = source.slice(0, i).trimEnd().slice(-1)
      const regexStart = prev === '' || /[=(:,![&|?{}+\-*%;<>~^]/.test(prev)
      if (regexStart) {
        i += 1
        let inClass = false
        while (i < n) {
          const c = source[i]
          if (c === '\\') { i += 2; continue }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) { i += 1; break }
          else if (c === '\n') break
          i += 1
        }
        while (i < n && /[gimsuy]/.test(source[i])) i += 1
        continue
      }
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let value = ''
      i += 1
      while (i < n) {
        const c = source[i]
        if (c === '\\') {
          value += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === quote) {
          i += 1
          break
        }
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          // 模板占位符：跳过表达式，但保留标记
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1
            else if (source[i] === '}') depth -= 1
            i += 1
          }
          value += '${…}'
          continue
        }
        value += c
        i += 1
      }
      out.push(value)
      continue
    }
    i += 1
  }
  return out
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, files)
    else if (name.endsWith('.js')) files.push(p)
  }
  return files
}

// 这些文件里的中文是**故意保留**的：
//   voice.js 里的 PowerShell 脚本体、text/project 的中文错误词表、markers 的旧前缀兼容
const INTENTIONAL = new Set([
  'src/voice.js',
  'src/text.js',
  'src/project.js',
  'src/core/markers.js',
  'src/server/headless.js',
])

const strict = process.argv.includes('--strict')
const rows = []
let total = 0
for (const file of walk(root)) {
  const literals = stringLiterals(readFileSync(file, 'utf8')).filter((s) => CJK.test(s))
  if (!literals.length) continue
  // Windows 的 path.relative 给反斜杠，白名单里写的是正斜杠
  const rel = path.relative(path.join(root, '..'), file).split(path.sep).join('/')
  if (INTENTIONAL.has(rel)) continue
  rows.push({ file: path.relative(path.join(root, '..'), file), count: literals.length, sample: literals[0].slice(0, 60) })
  total += literals.length
}

rows.sort((a, b) => b.count - a.count)
console.log('中文出现在字符串字面量里的位置：')
for (const r of rows) console.log(`  ${String(r.count).padStart(4)}  ${r.file.padEnd(34)} e.g. ${r.sample}`)
console.log(`\n合计 ${total} 条（${rows.length} 个文件）`)

if (strict && total > 0) {
  console.error('\n--strict：src/ 里仍有中文字符串，英文闸门未通过')
  process.exit(1)
}
