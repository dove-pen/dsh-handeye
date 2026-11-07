// Read/control routes for the drawer.
//
// Same-origin, local only, no credentials. Writes are limited to pausing,
// resuming and granting one user confirmation; capabilities and cards are
// otherwise read-only from the UI.

import { createLogReader } from '../runtime/logReader.js'
import { compileEpisode } from '../runtime/compile.js'
import { newEpisodeId } from '../memory/episodes.js'
import { summarizeGoal } from '../memory/goals.js'
import { computeMetrics } from '../core/metrics.js'
import { runHandeye } from '../handeye.js'
import { pause, resumeByUser, satisfyReplan } from '../core/state.js'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const MAX_BODY = 64 * 1024

/** One-shot human override of the acceptance gate (consumed by the next checkpoint). */
async function writeOverride({ episodeId, reason, goalId, stepId }) {
  const dir = runtimeDataDir()
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'override.json')
  await writeFile(file, `${JSON.stringify({ episodeId, reason, goalId, stepId, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return file
}

function runtimeDataDir() {
  const base = process.env.LOCALAPPDATA || process.env.TMPDIR || '.'
  return path.join(base, 'dsh-handeye-plus')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 跨站写请求拦截。
 *
 * 这些路由挂在宿主同源的 localhost 上，没有鉴权。浏览器对 application/json 的跨站 POST
 * 会先发预检，但 text/plain 属于「简单请求」——不预检、直接打过来。所以任意网页都能
 * 构造 POST 去调 /goals/override，把「人工放行」这道唯一的门禁绕过。
 * 两道关：Origin 必须是同源；写请求必须是 application/json。
 */
function isCrossOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return false // curl / 本地脚本没有 Origin 头
  const host = String(req.headers?.host || '')
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

function badRequest(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readBody(req) {
  if (isCrossOrigin(req)) throw badRequest(403, 'cross-origin write rejected')
  const type = String(req.headers?.['content-type'] || '')
  if (!/application\/json/i.test(type)) throw badRequest(415, 'content-type must be application/json')
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
    path: s.path,
    pathIndex: s.pathIndex,
    actionsSinceCheckpoint: s.actionsSinceCheckpoint,
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
                  sendJson(res, (error && error.status) || 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
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

      reg('/dsh-handeye-plus/cards/run', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const card = await runtime.cards.get(String(body.id || ''))
        if (!card.ok) return sendJson(res, 404, { ok: false, error: card.message })
        const name = card.value.directCapability
        if (!name) return sendJson(res, 400, { ok: false, error: 'this card has no direct capability' })

        const found = await runtime.capabilities.get(name)
        if (!found.ok) return sendJson(res, 404, { ok: false, error: found.message })
        const capability = found.value
        if (capability.status !== 'enabled') {
          return sendJson(res, 400, { ok: false, error: `capability "${name}" is ${capability.status}` })
        }
        if (capability.risk !== 'read') {
          return sendJson(res, 400, { ok: false, error: 'direct run is limited to read-only capabilities' })
        }
        if (capability.firstRunConfirmed !== true) {
          const granted = runtime.confirm.consumeFor(name, 'read')
          if (!granted.ok) {
            return sendJson(res, 409, { ok: false, error: 'CONFIRM_REQUIRED', name })
          }
          await runtime.capabilities.markFirstRun(name)
        }
        const started = Date.now()
        const result = await runtime.executor.run(capability, body.params ?? {}, { confirmed: true })
        await runtime.capabilities.recordRun(name, { ok: result.ok, error: result.ok ? '' : result.message })
        await runtime.episodes.append({
          id: newEpisodeId(new Date()),
          startedAt: new Date(started).toISOString(),
          endedAt: new Date().toISOString(),
          intent: { text: card.value.title, source: 'card-direct' },
          steps: [{ seq: 1, tool: 'capability', args: { name }, ok: result.ok, ms: Date.now() - started }],
          outcome: result.ok ? 'success' : 'failure',
        })
        return sendJson(res, 200, { ok: true, name, result, ms: Date.now() - started })
      })

      reg('/dsh-handeye-plus/metrics', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const listed = await runtime.goals.list()
        if (!listed.ok) return sendJson(res, 500, listed)
        const refusals = typeof runtime.refusals === 'function' ? runtime.refusals() : {}
        return sendJson(res, 200, { ok: true, ...computeMetrics({ goals: listed.value, refusals }) })
      })

      reg('/dsh-handeye-plus/goals', async (req, res) => {
        if (req.method === 'GET') {
          const listed = await runtime.goals.list()
          if (!listed.ok) return sendJson(res, 500, listed)
          return sendJson(res, 200, {
            ok: true,
            goals: listed.value.map((doc) => ({
              ...summarizeGoal(doc),
              longTermGoal: doc.longTermGoal,
              updatedAt: doc.updatedAt,
              steps: doc.steps,
            })),
          })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const created = await runtime.goals.create({
            title: String(body.title || ''),
            longTermGoal: String(body.longTermGoal || ''),
            steps: Array.isArray(body.steps) ? body.steps : [],
          })
          return sendJson(res, created.ok ? 200 : 400, created)
        }
        return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
      })

      reg('/dsh-handeye-plus/goals/plan', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const saved = await runtime.goals.setPlan(String(body.id || ''), Array.isArray(body.steps) ? body.steps : [])
        return sendJson(res, saved.ok ? 200 : 400, saved)
      })

      reg('/dsh-handeye-plus/goals/set', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const saved = await runtime.goals.setStatus(String(body.id || ''), String(body.status || ''))
        return sendJson(res, saved.ok ? 200 : 400, saved)
      })

      // 人工放行：只写 override.json，下一次 checkpoint/step_done 消费掉
      reg('/dsh-handeye-plus/goals/override', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const reason = String(body.reason || '').trim()
        if (!reason) return sendJson(res, 400, { ok: false, error: 'reason is required' })
        const episodeId = String(runtime.state?.episodeId || '')
        if (!episodeId) return sendJson(res, 400, { ok: false, error: 'no episode is running' })
        try {
          await writeOverride({ episodeId, reason, goalId: body.goalId, stepId: body.stepId })
          return sendJson(res, 200, { ok: true, episodeId, reason })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error.message })
        }
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
        } else if (action === 'begin') {
          const intent = String(body.intent || '').trim()
          if (!intent) return sendJson(res, 400, { ok: false, error: 'intent is required' })
          const episodeId = await runtime.startEpisode(intent, {
            allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : undefined,
            path: Array.isArray(body.path) ? body.path : undefined,
            cardId: typeof body.cardId === 'string' ? body.cardId : undefined,
            verify: Array.isArray(body.verify) ? body.verify : undefined,
            params: body.params && typeof body.params === 'object' ? body.params : undefined,
          })
          return sendJson(res, 200, { ...stateSnapshot(runtime, version), episodeId })
        } else {
          return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
        }
        return sendJson(res, 200, stateSnapshot(runtime, version))
      })
    })
  })
}
