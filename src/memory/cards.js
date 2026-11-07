// Task-card store: built-in prompts plus user and imported cards.
//
// Cards are instructions for the model, so an imported card is untrusted:
// it is forced to supervised autonomy and always shown in full before sending.

import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { ERR, failure, success } from '../core/errors.js'
import { validateCard } from './schema.js'

const ID_RE = /^[a-z][a-z0-9_]{2,40}$/

function nowIso(now) {
  return new Date(now()).toISOString()
}

export function createCardStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new TypeError('createCardStore requires dir')
  const cardDir = path.join(dir, 'cards')

  async function ensureDir() {
    await mkdir(cardDir, { recursive: true })
  }

  async function fileOf(id) {
    return path.join(cardDir, `${id}.json`)
  }

  async function writeDoc(id, doc) {
    await ensureDir()
    const file = await fileOf(id)
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async function get(id) {
    const key = String(id ?? '')
    if (!ID_RE.test(key)) return failure(ERR.CARD_INVALID, 'Invalid card id')
    try {
      const doc = JSON.parse(await readFile(await fileOf(key), 'utf8'))
      const check = validateCard(doc)
      if (!check.ok) return failure(ERR.CARD_INVALID, 'Stored card is invalid', check.errors)
      return success(doc)
    } catch (error) {
      if (error.code === 'ENOENT') return failure(ERR.NOT_FOUND, `Card "${key}" not found`)
      return failure(ERR.INTERNAL, `Card read failed: ${error.message}`)
    }
  }

  async function list({ origin, enabled } = {}) {
    try {
      await ensureDir()
      const names = (await readdir(cardDir)).filter((n) => n.endsWith('.json'))
      const out = []
      for (const file of names) {
        try {
          const doc = JSON.parse(await readFile(path.join(cardDir, file), 'utf8'))
          if (!validateCard(doc).ok) continue
          if (origin && doc.origin !== origin) continue
          if (enabled !== undefined && Boolean(doc.enabled) !== Boolean(enabled)) continue
          out.push(doc)
        } catch {
          // skip malformed card; one bad file must not hide the rest
        }
      }
      out.sort((a, b) => String(a.title).localeCompare(String(b.title)))
      return success(out)
    } catch (error) {
      return failure(ERR.INTERNAL, `Card list failed: ${error.message}`)
    }
  }

  async function installBuiltin(card) {
    const check = validateCard(card)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Builtin card is invalid', check.errors)
    const current = await get(card.id)
    if (current.ok) {
      const newer = Number(card.version ?? 1) > Number(current.value.version ?? 1)
      if (current.value.origin === 'builtin' && newer) {
        const doc = {
          ...card,
          schemaVersion: 1,
          origin: 'builtin',
          version: Number(card.version ?? 1),
          enabled: current.value.enabled !== false,
          createdAt: current.value.createdAt,
          updatedAt: nowIso(now),
        }
        await writeDoc(doc.id, doc)
        return success({ card: doc, updated: true })
      }
      return success({ card: current.value, skipped: true })
    }
    const doc = {
      ...card,
      schemaVersion: 1,
      origin: 'builtin',
      version: card.version ?? 1,
      enabled: card.enabled !== false,
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    }
    await writeDoc(doc.id, doc)
    return success({ card: doc, skipped: false })
  }

  async function saveUser(card) {
    const check = validateCard(card)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Card is invalid', check.errors)
    const current = await get(card.id)
    const doc = {
      ...card,
      schemaVersion: 1,
      origin: 'user',
      version: current.ok ? Number(current.value.version ?? 1) + 1 : 1,
      enabled: card.enabled !== false,
      createdAt: current.ok ? current.value.createdAt : nowIso(now),
      updatedAt: nowIso(now),
    }
    await writeDoc(doc.id, doc)
    return success(doc)
  }

  async function importCard(card) {
    const check = validateCard(card)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Imported card is invalid', check.errors)
    const current = await get(card.id)
    if (current.ok) return failure(ERR.CARD_INVALID, `Card "${card.id}" already exists`)
    const doc = {
      ...card,
      schemaVersion: 1,
      origin: 'imported',
      autonomy: 'supervised',
      version: 1,
      enabled: true,
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    }
    await writeDoc(doc.id, doc)
    return success(doc)
  }

  async function setEnabled(id, enabled) {
    const current = await get(id)
    if (!current.ok) return current
    const doc = { ...current.value, enabled: Boolean(enabled), updatedAt: nowIso(now) }
    await writeDoc(doc.id, doc)
    return success(doc)
  }

  async function remove(id) {
    const current = await get(id)
    if (!current.ok) return current
    try {
      await unlink(await fileOf(id))
      return success({ id })
    } catch (error) {
      return failure(ERR.INTERNAL, `Card delete failed: ${error.message}`)
    }
  }

  return { get, list, installBuiltin, saveUser, importCard, setEnabled, remove, dir: cardDir }
}
