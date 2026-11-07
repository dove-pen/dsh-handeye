// Capability store: one JSON file per capability.
//
// Lifecycle: draft -> enabled <-> disabled. Only enabled capabilities may run.
// Every write validates the full document first, so a malformed capability can
// never reach the executor.

import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { ERR, failure, success } from '../core/errors.js'
import { validateCapability } from './schema.js'

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/

function nowIso(now) {
  return new Date(now()).toISOString()
}

async function readJson(file) {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

export function createCapabilityStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new TypeError('createCapabilityStore requires dir')
  const capDir = path.join(dir, 'capabilities')

  async function ensureDir() {
    await mkdir(capDir, { recursive: true })
  }

  async function fileOf(name) {
    return path.join(capDir, `${name}.json`)
  }

  async function writeDoc(name, doc) {
    await ensureDir()
    const file = await fileOf(name)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async function get(name) {
    const key = String(name ?? '')
    if (!NAME_RE.test(key)) return failure(ERR.CAPABILITY_INVALID, 'Invalid capability name')
    try {
      const doc = await readJson(await fileOf(key))
      const check = validateCapability(doc)
      if (!check.ok) return failure(ERR.CAPABILITY_INVALID, 'Stored capability is invalid', check.errors)
      return success(doc)
    } catch (error) {
      if (error.code === 'ENOENT') return failure(ERR.NOT_FOUND, `Capability "${key}" not found`)
      return failure(ERR.INTERNAL, `Capability read failed: ${error.message}`)
    }
  }

  async function list({ status } = {}) {
    try {
      await ensureDir()
      const names = (await readdir(capDir)).filter((n) => n.endsWith('.json'))
      const out = []
      for (const file of names) {
        try {
          const doc = await readJson(path.join(capDir, file))
          if (!validateCapability(doc).ok) continue
          if (status && doc.status !== status) continue
          out.push(doc)
        } catch {
          // skip malformed file; one bad capability must not hide the rest
        }
      }
      out.sort((a, b) => String(a.title).localeCompare(String(b.title)))
      return success(out)
    } catch (error) {
      return failure(ERR.INTERNAL, `Capability list failed: ${error.message}`)
    }
  }

  async function saveDraft(input) {
    const check = validateCapability(input)
    if (!check.ok) return failure(ERR.CAPABILITY_INVALID, 'Capability is invalid', check.errors)

    const existing = await get(input.name)
    if (existing.ok && existing.value.status === 'enabled') {
      return failure(ERR.CAPABILITY_INVALID, 'Disable the capability before replacing it')
    }

    const stamp = nowIso(now)
    const doc = {
      ...input,
      schemaVersion: 1,
      status: 'draft',
      origin: input.origin === 'builtin' || input.origin === 'imported' ? input.origin : 'user',
      version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
      createdAt: existing.ok ? existing.value.createdAt : stamp,
      updatedAt: stamp,
      stats: existing.ok
        ? { ...existing.value.stats, runs: 0, success: 0, lastRunAt: null, lastError: null }
        : { runs: 0, success: 0, lastRunAt: null, lastError: null },
      firstRunConfirmed: false,
    }
    await writeDoc(doc.name, doc)
    return success(doc)
  }

  async function setStatus(name, status) {
    const current = await get(name)
    if (!current.ok) return current
    const doc = { ...current.value, status, updatedAt: nowIso(now) }
    await writeDoc(doc.name, doc)
    return success(doc)
  }

  async function enable(name) {
    const current = await get(name)
    if (!current.ok) return current
    if (current.value.status === 'draft' || current.value.status === 'disabled') {
      return setStatus(name, 'enabled')
    }
    return success(current.value)
  }

  async function disable(name) {
    const current = await get(name)
    if (!current.ok) return current
    return setStatus(name, 'disabled')
  }

  async function remove(name) {
    const current = await get(name)
    if (!current.ok) return current
    try {
      await unlink(await fileOf(name))
      return success({ name })
    } catch (error) {
      return failure(ERR.INTERNAL, `Capability delete failed: ${error.message}`)
    }
  }

  async function recordRun(name, { ok = false, ms = 0, error = '' } = {}) {
    const current = await get(name)
    if (!current.ok) return current
    const stats = { ...(current.value.stats ?? { runs: 0, success: 0 }) }
    stats.runs = (stats.runs ?? 0) + 1
    if (ok) stats.success = (stats.success ?? 0) + 1
    stats.lastRunAt = nowIso(now)
    stats.lastError = ok ? null : String(error)
    const doc = { ...current.value, stats, updatedAt: nowIso(now) }
    await writeDoc(doc.name, doc)
    return success(doc)
  }

  /** Copy a preset into the store. Existing capabilities are never overwritten. */
  async function installPreset(preset, { enabled = false } = {}) {
    const check = validateCapability(preset)
    if (!check.ok) return failure(ERR.CAPABILITY_INVALID, 'Preset is invalid', check.errors)
    const current = await get(preset.name)
    if (current.ok) return success({ capability: current.value, skipped: true })

    const stamp = nowIso(now)
    const doc = {
      ...preset,
      schemaVersion: 1,
      origin: 'builtin',
      status: enabled ? 'enabled' : 'disabled',
      version: preset.version ?? 1,
      createdAt: stamp,
      updatedAt: stamp,
      stats: { runs: 0, success: 0, lastRunAt: null, lastError: null },
      firstRunConfirmed: false,
    }
    await writeDoc(doc.name, doc)
    return success({ capability: doc, skipped: false })
  }

  /** Import is untrusted by definition: force origin and keep it disabled. */
  async function importCapability(preset) {
    const check = validateCapability(preset)
    if (!check.ok) return failure(ERR.CAPABILITY_INVALID, 'Imported capability is invalid', check.errors)
    const current = await get(preset.name)
    if (current.ok) return failure(ERR.CAPABILITY_INVALID, `Capability "${preset.name}" already exists`)
    const stamp = nowIso(now)
    const doc = {
      ...preset,
      schemaVersion: 1,
      origin: 'imported',
      status: 'disabled',
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
      stats: { runs: 0, success: 0, lastRunAt: null, lastError: null },
      firstRunConfirmed: false,
    }
    await writeDoc(doc.name, doc)
    return success(doc)
  }

  async function markFirstRun(name) {
    const current = await get(name)
    if (!current.ok) return current
    const doc = { ...current.value, firstRunConfirmed: true, updatedAt: nowIso(now) }
    await writeDoc(doc.name, doc)
    return success(doc)
  }

  return { get, list, saveDraft, enable, disable, remove, recordRun, markFirstRun, installPreset, importCapability, dir: capDir }
}
