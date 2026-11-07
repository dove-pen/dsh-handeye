// Waiting and region reading, on top of handeye's `see`.
//
// Both exist because a real task went like this: "Start-Sleep 12, screenshot,
// look, screenshot again" - and the one number that mattered (a 32-character
// confirmation code) was misread at 1x, so the model had to select-all, copy,
// and regex the clipboard to get it right. That is the tool's job, not the
// model's.
import { runHandeye } from './handeye.js'

const DEFAULT_POLL_MS = 400

// ---------------------------------------------------------------- pure helpers

/**
 * argv for "block until this text shows up". handeye polls internally.
 *
 * Default profile is --best, not --fast: this is one blocking call, and the
 * fast profile genuinely cannot read small UI text ("HARNESS" in a 9px header
 * is a real example - fast missed it, best scored 1.00). Polling modes
 * (gone / change) keep the cheap profile because they run in a loop.
 */
export function buildWaitArgs({ text, timeoutMs = 8000, fast = false } = {}) {
  const argv = ['see', '--json', '--wait', String(text ?? ''), '--timeout', String(Math.max(200, Math.round(timeoutMs)))]
  argv.push(fast ? '--fast' : '--best')
  return argv
}

/** argv for a one-shot "is this text on screen right now" question. */
export function buildFindArgs({ text, fast = true } = {}) {
  const argv = ['see', '--json', '--find', String(text ?? ''), '--scale', '2']
  if (fast) argv.push('--fast')
  return argv
}

/** argv for OCR limited to a rectangle (cheaper and far more accurate). */
export function buildRegionArgs({ region, scale = 3, fast = false } = {}) {
  const argv = ['see', '--json', '--region', String(region), '--scale', String(Math.min(4, Math.max(1, Math.round(scale))))]
  argv.push(fast ? '--fast' : '--best')
  return argv
}

/**
 * Normalise what handeye prints for --wait / --find. It writes the same JSON on
 * success and on timeout, so the exit code alone is not enough.
 */
export function parseSeeJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  const firstLine = text.split(/\r?\n/, 1)[0]
  try {
    return JSON.parse(firstLine)
  } catch {
    return null
  }
}

/** Turn a --wait result into the sentence the model should read. */
export function formatWaitResult(wait, { text, mode = 'appear' } = {}) {
  if (!wait) return `等「${text}」：手眼没有返回结果。`
  if (wait.found === true) {
    const pos = Number.isFinite(wait.x) ? ` @(${wait.x},${wait.y} ${wait.w}x${wait.h})` : ''
    const took = Number.isFinite(wait.elapsedMs) ? `，等了 ${wait.elapsedMs}ms` : ''
    return `「${text}」出现了${pos}${took}`
  }
  const took = Number.isFinite(wait.elapsedMs) ? `（等了 ${wait.elapsedMs}ms）` : ''
  const why = wait.error === 'timeout' ? '超时' : wait.error || '没有找到'
  if (mode === 'gone') return `「${text}」已经消失${took}`
  return `等「${text}」失败：${why}${took}。可以先用 eye_see 看看现在是什么画面，再决定要不要继续等。`
}

// ---------------------------------------------------------------- waiting

/**
 * Block until `text` appears on screen.
 * @returns {Promise<object|null>} handeye's JSON ({found,text,x,y,w,h,elapsedMs})
 */
export async function waitForText({ text, timeoutMs = 8000, fast = false }) {
  const budget = Math.max(500, Math.round(timeoutMs))
  const r = await runHandeye(buildWaitArgs({ text, timeoutMs: budget, fast }), { timeoutMs: budget + 20000 })
  return parseSeeJson(r.stdout)
}

/** Block until `text` is no longer anywhere on screen (polls). */
export async function waitForGone({ text, timeoutMs = 8000, fast = true, intervalMs = DEFAULT_POLL_MS }) {
  const deadline = Date.now() + Math.max(300, timeoutMs)
  let last = null
  const started = Date.now()
  for (;;) {
    const r = await runHandeye(buildFindArgs({ text, fast }), { timeoutMs: 20000 })
    const j = parseSeeJson(r.stdout)
    if (j) last = j
    const hits = Array.isArray(j?.hits) ? j.hits : []
    if (j && j.ok !== false && hits.length === 0) {
      return { found: false, gone: true, elapsedMs: Date.now() - started, text }
    }
    if (Date.now() >= deadline) {
      return {
        found: true,
        gone: false,
        elapsedMs: Date.now() - started,
        text,
        error: 'timeout',
        hits: last?.hits || [],
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Block until the screen image changes at all (cheapest possible wait). */
export async function waitForChange({ timeoutMs = 8000, intervalMs = DEFAULT_POLL_MS }) {
  const deadline = Date.now() + Math.max(300, timeoutMs)
  const started = Date.now()
  let last = null
  for (;;) {
    const r = await runHandeye(['see', '--json', '--changed'], { timeoutMs: 20000 })
    const j = parseSeeJson(r.stdout)
    if (j) last = j
    if (j?.delta?.changed === true) {
      return { changed: true, elapsedMs: Date.now() - started, delta: j.delta }
    }
    if (Date.now() >= deadline) {
      return { changed: false, elapsedMs: Date.now() - started, delta: last?.delta || null, error: 'timeout' }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------- region

/**
 * OCR just one rectangle. Far more reliable than full-screen OCR when the text
 * that matters is a code, an amount or a timestamp.
 */
export async function readRegion({ region, scale = 3, fast = false }) {
  const r = await runHandeye(buildRegionArgs({ region, scale, fast }), { timeoutMs: 40000 })
  const j = parseSeeJson(r.stdout)
  if (!j) {
    return { ok: false, error: r.stderr?.trim() || '没有读到结果', lines: [] }
  }
  const lines = []
  for (const block of j.blocks || []) {
    for (const item of block.items || []) {
      const t = String(item.text ?? '').trim()
      if (t) lines.push({ text: t, x: item.x, y: item.y, kind: block.kind })
    }
  }
  return { ok: j.ok !== false, lines, screen: j.screen || null }
}
