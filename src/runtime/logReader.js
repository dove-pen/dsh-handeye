// Read and summarize handeye's system log.
//
// The module is deliberately dependency-injected: `run(argv) -> { ok, code, stdout, stderr }`
// so tests can feed fixtures and production can hand in the handeye wrapper.

import { ERR, failure } from '../core/errors.js'
import { redactText } from '../memory/redact.js'

const DEFAULT_TAIL = 200
const MAX_TAIL = 2000

const LEVEL_NAMES = { 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information', 5: 'Verbose' }

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function buildTailArgs(opts = {}) {
  const argv = ['log', '--json', '--tail', String(clampInt(opts.tail, 1, MAX_TAIL, DEFAULT_TAIL))]
  if (typeof opts.level === 'string' && opts.level.trim()) argv.push('--level', opts.level.trim())
  if (typeof opts.source === 'string' && opts.source.trim()) argv.push('--source', opts.source.trim())
  if (opts.id !== undefined && opts.id !== null && opts.id !== '') {
    const id = Number(opts.id)
    if (Number.isInteger(id)) argv.push('--id', String(id))
  }
  if (typeof opts.grep === 'string' && opts.grep.trim()) argv.push('--grep', opts.grep.trim())
  if (typeof opts.since === 'string' && opts.since.trim()) argv.push('--since', opts.since.trim())
  return argv
}

export function normalizeEvent(event) {
  const level = Number(event?.level) || 0
  return {
    time: String(event?.time ?? ''),
    level,
    levelName: String(event?.levelName ?? LEVEL_NAMES[level] ?? ''),
    source: String(event?.source ?? ''),
    eventId: Number.isInteger(event?.eventId) ? event.eventId : Number(event?.eventId) || 0,
    category: String(event?.category ?? ''),
    desc: redactText(String(event?.desc ?? '')),
    detail: redactText(String(event?.detail ?? '')),
  }
}

export function parseLogOutput(stdout) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout ?? ''))
  } catch {
    return failure(ERR.INTERNAL, 'Invalid log JSON')
  }
  if (!parsed || !Array.isArray(parsed.events)) {
    return failure(ERR.INTERNAL, 'Log output has no events array')
  }
  return { ok: true, count: parsed.events.length, events: parsed.events.map(normalizeEvent) }
}

export function summarize(events) {
  const list = Array.isArray(events) ? events : []
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const bySource = {}
  const sessions = new Set()
  let errors = 0
  let warnings = 0

  for (const e of list) {
    if (byLevel[e.level] !== undefined) byLevel[e.level] += 1
    if (e.source) bySource[e.source] = (bySource[e.source] || 0) + 1
    if (e.level === 1 || e.level === 2) errors += 1
    if (e.level === 3) warnings += 1
    const match = /S=([0-9a-f]+)/i.exec(e.detail || '')
    if (match) sessions.add(match[1])
  }

  return {
    total: list.length,
    byLevel,
    bySource,
    errors,
    warnings,
    sessions: sessions.size,
    lastTime: list.length ? list[list.length - 1].time : '',
  }
}

/**
 * @param {object} deps
 * @param {(argv:string[]) => Promise<{ok:boolean, code?:number, stdout?:string, stderr?:string}>} deps.run
 */
export function createLogReader({ run, cacheMs = 2000, now = () => Date.now() } = {}) {
  if (typeof run !== 'function') throw new TypeError('createLogReader requires run(argv)')

  let cache = null
  let cacheKey = ''
  let cacheAt = 0

  async function tail(opts = {}) {
    const key = JSON.stringify(opts)
    if (cache && key === cacheKey && now() - cacheAt < cacheMs) return cache

    let result
    try {
      result = await run(buildTailArgs(opts))
    } catch (error) {
      return failure(ERR.INTERNAL, `Log reader failed: ${error instanceof Error ? error.message : error}`)
    }
    if (!result || result.ok !== true) {
      const code = result?.code ?? '?'
      const stderr = String(result?.stderr ?? '').trim()
      return failure(ERR.INTERNAL, `handeye log failed (${code})${stderr ? `: ${stderr}` : ''}`)
    }

    const parsed = parseLogOutput(result.stdout)
    if (parsed.ok) {
      cache = parsed
      cacheKey = key
      cacheAt = now()
    }
    return parsed
  }

  return { tail }
}
