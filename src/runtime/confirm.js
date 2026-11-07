// One-shot confirmation tokens.
//
// A capability with risk "write" or "destructive" must present a token that the
// user obtained by an explicit confirmation. Tokens are single-use and expire.

import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 2 * 60 * 1000

export function createConfirmStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const tokens = new Map()

  function mint(risk, reason = '') {
    if (risk !== 'write' && risk !== 'destructive') {
      throw new TypeError('confirm tokens are minted only for write/destructive actions')
    }
    const token = `cf_${randomBytes(4).toString('hex')}`
    tokens.set(token, { risk, reason: String(reason), expiresAt: now() + ttlMs })
    return token
  }

  function consume(token, risk) {
    const key = String(token ?? '')
    const entry = tokens.get(key)
    if (!entry) return { ok: false, message: 'Unknown or already-used confirmation token' }
    if (entry.expiresAt < now()) {
      tokens.delete(key)
      return { ok: false, message: 'Confirmation token expired' }
    }
    if (entry.risk !== risk) {
      return { ok: false, message: `Token is for ${entry.risk}, not ${risk}` }
    }
    tokens.delete(key)
    return { ok: true, reason: entry.reason }
  }

  function peek(token) {
    const entry = tokens.get(String(token ?? ''))
    if (!entry) return null
    if (entry.expiresAt < now()) {
      tokens.delete(String(token))
      return null
    }
    return { ...entry }
  }

  function size() {
    return tokens.size
  }

  return { mint, consume, peek, size }
}
