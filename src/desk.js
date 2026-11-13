// 后台控件操作：封装 uia.ps1，全程不移动鼠标、不把窗口提到前台。
//
// 这是从 dsh-computer-use-win 学来的最有价值的一点：
//   - 能后台按控件（invoke / set_value）就不要用鼠标点
//   - 能用控件名字找就不要用坐标猜
//   - 批量动作一次进程内跑完，省掉每步几百毫秒的启动
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PS = process.env.DSH_HANDEYE_PS || 'powershell.exe'
const SCRIPT = fileURLToPath(new URL('./uia.ps1', import.meta.url))

export function uiaScriptPath() {
  return SCRIPT
}

/**
 * 跑一次 UIA 后端。
 * @param {Record<string,string|number>} args 对应 uia.ps1 的参数名（首字母大写）
 */
export function runUia(args, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-handeye-'))
    const outFile = path.join(dir, 'out.json')
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === '') continue
      argv.push(`-${k}`, String(v))
    }
    argv.push('-Out', outFile)

    let stderr = ''
    let child
    try {
      child = spawn(PS, argv, { windowsHide: true })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      reject(e)
      return
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { }
    }, timeoutMs)

    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let json = null
      try {
        json = JSON.parse(readFileSync(outFile, 'utf8'))
      } catch {
        json = null
      }
      rmSync(dir, { recursive: true, force: true })
      if (json === null) {
        reject(new Error(`UIA backend returned nothing (exit ${code})${stderr ? ': ' + stderr.slice(0, 300) : ''}`))
        return
      }
      resolve(json)
    })
  })
}

function assertOk(json, what) {
  if (!json || json.ok !== true) {
    throw new Error(`${what} failed: ${json?.error || 'unknown reason'}`)
  }
  return json
}

// ---------------------------------------------------------------- 工具函数

export async function listWindows() {
  const j = assertOk(await runUia({ Mode: 'windows' }), 'list windows')
  return j.windows || []
}

export async function treeOf(hwnd, { depth = 3, max = 400 } = {}) {
  const j = assertOk(await runUia({ Mode: 'tree', Hwnd: hwnd, Depth: depth, Max: max }), 'read control tree')
  return j.nodes || []
}

export async function textOf(hwnd, { depth = 8, max = 800 } = {}) {
  const j = assertOk(await runUia({ Mode: 'text', Hwnd: hwnd, Depth: depth, Max: max }), 'read window text')
  return j.lines || []
}

export async function invokeRef(ref) {
  const j = assertOk(await runUia({ Mode: 'invoke', Ref: ref }), 'invoke control')
  return j
}

export async function setValueRef(ref, value) {
  const j = assertOk(await runUia({ Mode: 'setvalue', Ref: ref, Value: value }), 'set control value')
  return j
}

export async function focusRef(ref) {
  const j = assertOk(await runUia({ Mode: 'focus', Ref: ref }), 'focus control')
  return j
}

export async function launchApp(target, targetArgs = '') {
  const j = assertOk(await runUia({ Mode: 'launch', Target: target, TargetArgs: targetArgs }), 'launch program')
  return j
}

/** 批量执行：一次 PowerShell 进程内跑完 1~N 个已规划动作，出错即停。 */
export async function batchActions(actions, { timeoutMs = 60000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-handeye-batch-'))
  const file = path.join(dir, 'actions.json')
  writeFileSync(file, JSON.stringify(actions), 'utf8')
  try {
    const j = await runUia({ Mode: 'batch', ActionFile: file }, { timeoutMs })
    return j
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 给模型看的格式化

/** 控件树压成缩进文本：只要名字、类型、ref、位置，不要一堆空节点。 */
export function formatTree(nodes) {
  const out = []
  const byRef = new Map(nodes.map((n) => [n.ref, n]))
  let shown = 0
  for (const n of nodes) {
    const depth = (n.ref.split(':')[1] || '').split('.').filter(Boolean).length
    const named = (n.name || '').trim() !== ''
    const hasPattern = Array.isArray(n.patterns) && n.patterns.length > 0
    if (!named && !hasPattern) continue
    const pad = '  '.repeat(Math.max(0, depth - 1))
    const pos = n.w || n.h ? ` @(${n.x},${n.y} ${n.w}x${n.h})` : ''
    const pat = hasPattern ? ` [${n.patterns.join(',')}]` : ''
    const label = named ? JSON.stringify(n.name) : '(unnamed)'
    out.push(`${pad}${n.type} ${label}${pat}${pos} ref=${n.ref}`)
    shown += 1
    if (shown >= 200) {
      out.push(`… ${nodes.length - shown} more nodes hidden; raise max or reduce depth`)
      break
    }
  }
  if (out.length === 0) out.push('(no readable controls in this window; it is probably custom-drawn - use hand_click_text or a screenshot with OCR)')
  return out.join('\n')
}

/** 按名字模糊找控件，返回候选。 */
export function findControls(nodes, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const hits = []
  for (const n of nodes) {
    const name = String(n.name || '').toLowerCase()
    const autoId = String(n.autoId || '').toLowerCase()
    if (name.includes(q) || autoId.includes(q)) {
      hits.push(n)
    }
  }
  return hits
}
