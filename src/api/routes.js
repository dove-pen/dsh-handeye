// Read/control routes for the drawer.
//
// Same-origin, local only, no credentials. Writes are limited to pausing,
// resuming and granting one user confirmation; capabilities and cards are
// otherwise read-only from the UI.

import { createLogReader } from '../runtime/logReader.js'
import { compileEpisode } from '../runtime/compile.js'
import { runHandeye } from '../handeye.js'
import { pause, resumeByUser, satisfyReplan } from '../core/state.js'

const MAX_BODY = 64 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function stateSnapshot(runtime, version) {
  const s = runtime.state
  return {
    ok: true,
    state: s.state,
    reason: s.reason,
    needsReplan: s.needsReplan,
    intent: s.intent,
    episodeId: s.episodeId,
    budget: { steps: s.budget.steps, maxSteps: s.budget.maxSteps, startedAt: s.budget.startedAt },
    allowedTools: s.allowedTools,
    meta: { version, dataDir: runtime.dataDir },
  }
}

export function registerRoutes({ ctx, runtime, version }) {
  const logReader = createLogReader({
    run: (argv) => runHandeye(argv, { timeoutMs: 25000 }),
  })

  ctx.inject(['webServer'], (sub) => {
    sub.effect(() => {
      const reg = (path, handler) => {
        sub.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => {
            Promise.resolve()
              .then(() => handler(req, res))
              .catch((error) => {
                try {
                  sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
                } catch {
                  // response already closed
                }
              })
          },
        })
      }

      reg('/dsh-handeye-plus/state', (req, res) => {
        sendJson(res, 200, stateSnapshot(runtime, version))
      })

      reg('/dsh-handeye-plus/log/tail', async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const result = await logReader.tail({
          tail: Number(url.searchParams.get('tail') || 200),
          level: url.searchParams.get('level') || undefined,
          source: url.searchParams.get('source') || undefined,
          id: url.searchParams.get('id') || undefined,
          grep: url.searchParams.get('grep') || undefined,
        })
        sendJson(res, result.ok ? 200 : 500, result)
      })

      reg('/dsh-handeye-plus/episodes', async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const listed = await runtime.episodes.list({
          limit: Number(url.searchParams.get('limit') || 20),
          since: url.searchParams.get('since') || undefined,
        })
        sendJson(res, listed.ok ? 200 : 500, listed)
      })

      reg('/dsh-handeye-plus/capabilities', async (req, res) => {
        const listed = await runtime.capabilities.list()
        sendJson(res, listed.ok ? 200 : 500, listed)
      })

      reg('/dsh-handeye-plus/capabilities/set', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const name = String(body.name || '')
        if (!name) return sendJson(res, 400, { ok: false, error: 'name is required' })
        const result = body.enabled === true ? await runtime.capabilities.enable(name) : await runtime.capabilities.disable(name)
        return sendJson(res, result.ok ? 200 : 400, result)
      })

      reg('/dsh-handeye-plus/capabilities/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const episodeId = String(body.episodeId || '')
        const name = String(body.name || '')
        const title = String(body.title || '')
        if (!episodeId || !name || !title) {
          return sendJson(res, 400, { ok: false, error: 'episodeId, name and title are required' })
        }
        const found = await runtime.episodes.read(episodeId)
        if (!found.ok) return sendJson(res, 404, { ok: false, error: found.message })
        const compiled = compileEpisode(found.value, {
          name,
          title,
          description: body.description,
          risk: body.risk,
        })
        if (!compiled.ok) {
          return sendJson(res, 400, { ok: false, error: compiled.message, warnings: compiled.warnings })
        }
        const saved = await runtime.capabilities.saveDraft(compiled.capability)
        if (!saved.ok) return sendJson(res, 400, { ok: false, error: saved.message })
        return sendJson(res, 200, { ok: true, capability: saved.value, warnings: compiled.warnings })
      })

      reg('/dsh-handeye-plus/cards', async (req, res) => {
        const listed = await runtime.cards.list()
        sendJson(res, listed.ok ? 200 : 500, listed)
      })

      reg('/dsh-handeye-plus/cards/set', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const id = String(body.id || '')
        if (!id) return sendJson(res, 400, { ok: false, error: 'id is required' })
        const result = await runtime.cards.setEnabled(id, body.enabled !== false)
        return sendJson(res, result.ok ? 200 : 400, result)
      })

      reg('/dsh-handeye-plus/grant', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const name = String(body.name || '')
        const risk = body.risk === 'destructive' ? 'destructive' : body.risk === 'write' ? 'write' : 'read'
        if (!name) return sendJson(res, 400, { ok: false, error: 'name is required' })
        runtime.confirm.grant(name, risk, String(body.reason || 'User granted one run'))
        return sendJson(res, 200, { ok: true, name, risk })
      })

      reg('/dsh-handeye-plus/control', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const action = String(body.action || '')
        if (action === 'pause') {
          pause(runtime.state, String(body.reason || 'Paused from the panel'))
        } else if (action === 'resume') {
          resumeByUser(runtime.state)
        } else if (action === 'replan') {
          satisfyReplan(runtime.state, String(body.plan || ''))
        } else {
          return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
        }
        return sendJson(res, 200, stateSnapshot(runtime, version))
      })
    })
  })
}
