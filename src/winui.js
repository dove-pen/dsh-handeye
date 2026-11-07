// Foreground / hit-test / atomic click / region crop, backed by winui.ps1.
//
// The point of this module: a click must never be "fire and hope". Before the
// button goes down we ask Windows which window owns that pixel. If it is not
// the window we were told to click, nothing is clicked and the caller gets a
// precise, actionable error instead of a silent misfire.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PS = process.env.DSH_HANDEYE_PS || 'powershell.exe'
const SCRIPT = fileURLToPath(new URL('./winui.ps1', import.meta.url))

export function winuiScriptPath() {
  return SCRIPT
}

/** A winui.ps1 failure that carries the machine-readable code. */
export class WinUiError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'WinUiError'
    this.code = code
    this.extra = extra ?? null
  }
}

// ---------------------------------------------------------------- pure helpers

/**
 * Normalise the caller's target: an explicit hwnd wins, a title fragment is the
 * fallback, no target means "click wherever the pixel is, just tell me where".
 * @returns {{hwnd:number}|{title:string}|null}
 */
export function resolveTarget(args = {}) {
  const raw = Number(args?.hwnd)
  if (Number.isFinite(raw) && raw > 0) return { hwnd: Math.trunc(raw) }
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  if (title) return { title }
  return null
}

/** One-line description of a window record, for messages. */
export function describeWindow(win) {
  if (!win) return '（没有窗口）'
  const title = win.title ? JSON.stringify(win.title) : '（无标题）'
  const bits = [title, `hwnd=${win.hwnd}`]
  if (win.className) bits.push(`class=${win.className}`)
  if (win.minimized) bits.push('最小化')
  return bits.join(' ')
}

/**
 * Pick the best title match out of a window list.
 * Exact beats prefix beats substring; restored beats minimized; foreground wins ties.
 * The Windows side does the same thing in Find-Window; this copy exists so the
 * tool layer can explain *why* a title matched and so it is unit-testable.
 */
export function pickWindowByTitle(windows, title) {
  const needle = String(title ?? '').trim().toLowerCase()
  if (!needle || !Array.isArray(windows)) return null
  let best = null
  for (let i = 0; i < windows.length; i += 1) {
    const win = windows[i] || {}
    const lower = String(win.title ?? '').toLowerCase()
    let score = -1
    if (lower === needle) score = 300
    else if (lower.startsWith(needle)) score = 200
    else if (lower.includes(needle)) score = 100
    if (score < 0) continue
    if (!win.minimized) score += 20
    if (win.foreground) score += 10
    const candidate = { win, score, order: i }
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.order < best.order)) {
      best = candidate
    }
  }
  return best ? best.win : null
}

/** Render the JSON that winui.ps1 returned for a click into agent-facing text. */
export function formatClickResult(json) {
  if (!json || json.ok !== true) return '点击没有执行。'
  const lines = []
  const dry = json.dryRun === true
  lines.push(
    `${dry ? '预演通过（没有真的按下鼠标）' : '已点击'} (${json.x},${json.y})${json.button === 'right' ? ' 右键' : ''}${json.double ? ' 双击' : ''}`,
  )
  if (json.hit) lines.push(`命中窗口：${describeWindow(json.hit)}`)
  if (json.target) lines.push(`目标窗口：${describeWindow(json.target)}`)
  if (json.foreground) lines.push(`操作后前台：${describeWindow(json.foreground)}`)
  if (Number.isFinite(json.attempts) && json.attempts > 1) {
    lines.push(`（重新聚焦 ${json.attempts} 次才拿到目标窗口，说明有东西在抢前台）`)
  }
  return lines.join('\n')
}

/** Render the JSON for a focus attempt. */
export function formatFocusResult(json) {
  if (!json || json.ok !== true) return '切换窗口没有成功。'
  const lines = [`已切到 ${describeWindow(json.window)}`]
  if (json.foreground) lines.push(`当前前台：${describeWindow(json.foreground)}`)
  return lines.join('\n')
}

/** 900x600 at 3x is 2700x1800 - refuse to explode memory on a typo. */
export function clampScale(value, fallback = 3) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(8, Math.max(1, Math.round(n)))
}

// ---------------------------------------------------------------- runner

function runWin(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-handeye-winui-'))
    const outFile = path.join(dir, 'out.json')
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue
      if (typeof value === 'boolean') {
        if (value) argv.push(`-${key}`)
        continue
      }
      argv.push(`-${key}`, String(value))
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

    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
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
        reject(new WinUiError('no-output', `窗口后端没有产出结果（exit ${code}）${stderr ? '：' + stderr.slice(0, 300) : ''}`))
        return
      }
      if (json.ok === true) {
        resolve(json)
        return
      }
      reject(new WinUiError(json.code || 'failed', json.error || '未知原因', json.extra))
    })
  })
}

// ---------------------------------------------------------------- public API

export async function listTopWindows({ timeoutMs = 20000 } = {}) {
  const json = await runWin({ Mode: 'list' }, { timeoutMs })
  return Array.isArray(json.windows) ? json.windows : []
}

export async function windowAt(x, y, { timeoutMs = 15000 } = {}) {
  const json = await runWin({ Mode: 'hit', PosX: Math.round(x), PosY: Math.round(y) }, { timeoutMs })
  return json.window || null
}

/**
 * Click at absolute screen coordinates.
 *
 * When `target` is given, focus + hit-test + click happen inside one process and
 * the click is skipped entirely if the pixel belongs to another window.
 */
export async function clickAt({
  x,
  y,
  button = 'left',
  doubleClick = false,
  target = null,
  attempts = 5,
  dryRun = false,
  timeoutMs = 25000,
} = {}) {
  const args = {
    Mode: 'click',
    PosX: Math.round(Number(x)),
    PosY: Math.round(Number(y)),
    Button: button === 'right' ? 'right' : 'left',
    Attempts: Math.max(1, Math.min(10, Math.round(Number(attempts) || 5))),
    DryRun: !!dryRun,
  }
  if (doubleClick) args.Double = true
  if (target?.hwnd) args.Hwnd = String(target.hwnd)
  else if (target?.title) args.Title = target.title
  return runWin(args, { timeoutMs })
}

export async function focusWindowTarget(target, { timeoutMs = 20000, focusTimeoutMs = 1200 } = {}) {
  const args = { Mode: 'focus', FocusTimeoutMs: focusTimeoutMs }
  if (target?.hwnd) args.Hwnd = String(target.hwnd)
  else if (target?.title) args.Title = target.title
  else throw new WinUiError('bad-args', 'focus 需要 hwnd 或 title')
  return runWin(args, { timeoutMs })
}

/**
 * Capture a screen rectangle straight with GDI+ and scale it up in one process.
 * Independent of the OCR pipeline on purpose: reading a small code must not
 * depend on whether another tool managed to write a temp file.
 */
export async function grabRegion({
  x = 0,
  y = 0,
  w = 0,
  h = 0,
  scale = 3,
  outImage,
  timeoutMs = 25000,
} = {}) {
  if (!outImage) throw new WinUiError('bad-args', 'grab 需要输出路径')
  return runWin(
    {
      Mode: 'grab',
      Image: outImage,
      PosX: Math.round(Number(x) || 0),
      PosY: Math.round(Number(y) || 0),
      SizeW: Math.round(Number(w) || 0),
      SizeH: Math.round(Number(h) || 0),
      Scale: clampScale(scale),
    },
    { timeoutMs },
  )
}

/**
 * Crop a region out of an existing PNG and scale it up. Used by eye_region so a
 * model can read small text (a confirmation code, a timestamp) without OCR
 * guessing at 1x.
 */
export async function cropRegion({
  source,
  x = 0,
  y = 0,
  w = 0,
  h = 0,
  scale = 3,
  outImage,
  timeoutMs = 25000,
} = {}) {
  if (!source) throw new WinUiError('bad-args', 'crop 需要 source 图片')
  if (!outImage) throw new WinUiError('bad-args', 'crop 需要输出路径')
  return runWin(
    {
      Mode: 'crop',
      Source: source,
      Image: outImage,
      PosX: Math.round(Number(x) || 0),
      PosY: Math.round(Number(y) || 0),
      SizeW: Math.round(Number(w) || 0),
      SizeH: Math.round(Number(h) || 0),
      Scale: clampScale(scale),
    },
    { timeoutMs },
  )
}

/** Parse "x,y,w,h" (also accepts spaces or Chinese comma). Pure. */
export function parseRegion(region) {
  const text = String(region ?? '').replace(/[，\s]/g, ',')
  const parts = text.split(',').filter((s) => s !== '')
  if (parts.length < 4) return null
  const nums = parts.slice(0, 4).map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n))) return null
  const [x, y, w, h] = nums.map((n) => Math.round(n))
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}
