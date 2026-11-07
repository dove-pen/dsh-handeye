// Episode store: append-only JSONL, one file per local day.
//
// Write path always redacts first. Read path redacts again (defensive: files may
// predate the current rules). Malformed lines are skipped, never fatal.

import { mkdir, appendFile, readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { ERR, failure, success } from '../core/errors.js'
import { redactDeep } from './redact.js'

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1000

function pad(n) {
  return String(n).padStart(2, '0')
}

export function newEpisodeId(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `ep_${stamp}_${randomBytes(3).toString('hex')}`
}

export function dayKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item && typeof item === 'object') out.push(item)
    } catch {
      // skip malformed line
    }
  }
  return out
}

export function createEpisodeStore({ dir, now = () => Date.now(), keepDays = 30 } = {}) {
  if (!dir) throw new TypeError('createEpisodeStore requires dir')
  const episodesDir = path.join(dir, 'episodes')

  async function ensureDir() {
    await mkdir(episodesDir, { recursive: true })
  }

  async function dayFiles() {
    await ensureDir()
    const names = await readdir(episodesDir)
    return names.filter((n) => DAY_FILE_RE.test(n)).sort().reverse()
  }

  async function append(episode) {
    const safe = redactDeep(episode)
    if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
      return failure(ERR.INTERNAL, 'Episode must be an object')
    }
    if (typeof safe.id !== 'string' || !safe.id) {
      return failure(ERR.INTERNAL, 'Episode id is required')
    }
    const startedAt = typeof safe.startedAt === 'string' && safe.startedAt ? safe.startedAt : new Date(now()).toISOString()
    const day = dayKey(startedAt)
    if (!day) return failure(ERR.INTERNAL, 'Episode startedAt is invalid')

    safe.startedAt = startedAt
    const file = path.join(episodesDir, `${day}.jsonl`)
    try {
      await ensureDir()
      await appendFile(file, `${JSON.stringify(safe)}\n`, 'utf8')
      return success({ id: safe.id, file })
    } catch (error) {
      return failure(ERR.INTERNAL, `Episode append failed: ${error.message}`)
    }
  }

  async function list({ limit = 50, since, until } = {}) {
    const max = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 50
    const sinceMs = since ? new Date(since).getTime() : null
    const untilMs = until ? new Date(until).getTime() : null

    try {
      const files = await dayFiles()
      const out = []
      for (const name of files) {
        const text = await readFile(path.join(episodesDir, name), 'utf8')
        for (const item of parseLines(text)) {
          const ts = new Date(item.startedAt).getTime()
          if (sinceMs !== null && Number.isFinite(ts) && ts < sinceMs) continue
          if (untilMs !== null && Number.isFinite(ts) && ts > untilMs) continue
          out.push(redactDeep(item))
        }
        if (out.length >= max * 3) break // enough candidates to sort and slice
      }
      out.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      return success(out.slice(0, max))
    } catch (error) {
      return failure(ERR.INTERNAL, `Episode list failed: ${error.message}`)
    }
  }

  async function read(id) {
    const target = String(id ?? '')
    if (!target) return failure(ERR.INTERNAL, 'Episode id is required')
    try {
      const files = await dayFiles()
      for (const name of files) {
        const text = await readFile(path.join(episodesDir, name), 'utf8')
        for (const item of parseLines(text)) {
          if (item.id === target) return success(redactDeep(item))
        }
      }
      return failure(ERR.NOT_FOUND, `Episode "${target}" not found`)
    } catch (error) {
      return failure(ERR.INTERNAL, `Episode read failed: ${error.message}`)
    }
  }

  async function prune({ keepDays: days = keepDays, nowMs = now() } = {}) {
    const cutoff = new Date(nowMs - days * DAY_MS)
    const cutoffKey = dayKey(cutoff.toISOString())
    const removed = []
    try {
      for (const name of await dayFiles()) {
        const key = name.slice(0, 10)
        if (key < cutoffKey) {
          await unlink(path.join(episodesDir, name))
          removed.push(name)
        }
      }
      return success(removed)
    } catch (error) {
      return failure(ERR.INTERNAL, `Episode prune failed: ${error.message}`)
    }
  }

  return { append, list, read, prune, dir: episodesDir }
}
