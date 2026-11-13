// 路由冒烟测试。
//
// 为什么需要：2026-11-13 的真实 bug —— routes.js 里用了 `FORMATS_VERSION` 却没 import，
// JS 语法检查过得去、其他路由全正常，只有 /state 在运行时 500。这种"漏一个 import"
// 只有真的把每条路由跑一遍才抓得到。

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerRoutes } from '../../src/api/routes.js'

function makeHarness() {
  const handlers = new Map()
  const ctx = {
    inject: (names, cb) =>
      cb({
        effect: (fn) => {
          try {
            fn()
          } catch {}
        },
        webServer: { register: ({ path, handler }) => handlers.set(path, handler) },
      }),
  }
  const runtime = {
    state: { state: 'idle', budget: { steps: 0, maxSteps: 10 }, path: [], allowedTools: null },
    dataDir: 'X',
    logger: { warn() {}, info() {} },
    episodes: { list: async () => ({ ok: true, value: [] }) },
    goals: { list: async () => ({ ok: true, value: [] }) },
    skills: { list: async () => ({ ok: true, value: [] }) },
    capabilities: { list: async () => ({ ok: true, value: [] }) },
    cards: { list: async () => ({ ok: true, value: [] }) },
    refusals: () => ({}),
    pendingConfirm: () => null,
  }
  registerRoutes({ ctx, runtime, version: '0.0.0-test' })
  return { handlers }
}

function call(handler, url) {
  const res = {
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
  handler({ method: 'GET', url, headers: {} }, res)
  return new Promise((resolve) => setTimeout(() => resolve(res), 25))
}

const GET_ROUTES = [
  '/dsh-handeye-plus/state',
  '/dsh-handeye-plus/events',
  '/dsh-handeye-plus/skills',
  '/dsh-handeye-plus/cards',
  '/dsh-handeye-plus/capabilities',
  '/dsh-handeye-plus/goals',
  '/dsh-handeye-plus/metrics',
  '/dsh-handeye-plus/confirm/pending',
]

test('every GET route answers 200 with parseable JSON', async () => {
  const { handlers } = makeHarness()
  for (const path of GET_ROUTES) {
    const handler = handlers.get(path)
    assert.ok(handler, '没有注册路由 ' + path)
    const res = await call(handler, path)
    assert.equal(res.status, 200, path + ' 返回了 ' + res.status + '：' + String(res.body).slice(0, 120))
    assert.doesNotThrow(() => JSON.parse(res.body), path + ' 的响应不是 JSON')
  }
})

test('the dashboard route serves the panel HTML', async () => {
  const { handlers } = makeHarness()
  const res = await call(handlers.get('/dsh-handeye-plus/dashboard'), '/dsh-handeye-plus/dashboard')
  assert.equal(res.status, 200)
  assert.match(String(res.body), /HandEye/)
  assert.match(String(res.body), /dsh-handeye-plus/)
})

test('a cross-origin write is refused', async () => {
  const { handlers } = makeHarness()
  const handler = handlers.get('/dsh-handeye-plus/goals/set')
  assert.ok(handler, '没有注册 goals/set')
  const res = await call(handler, '/dsh-handeye-plus/goals/set')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
})

async function withRealRuntime(fn) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'routes-tut-'))
  const { createCardStore } = await import('../../src/memory/cards.js')
  const { createGoalStore } = await import('../../src/memory/goals.js')
  const { createState } = await import('../../src/core/state.js')
  const handlers = new Map()
  const ctx = {
    inject: (n, cb) => cb({ effect: (f) => { try { f() } catch {} }, webServer: { register: ({ path: p2, handler }) => handlers.set(p2, handler) } }),
  }
  const runtime = {
    state: createState(),
    dataDir: dir,
    logger: { warn() {}, info() {} },
    cards: createCardStore({ dir }),
    goals: createGoalStore({ dir }),
    episodes: { list: async () => ({ ok: true, value: [] }) },
    skills: { list: async () => ({ ok: true, value: [] }) },
    capabilities: { list: async () => ({ ok: true, value: [] }) },
    refusals: () => ({}),
    pendingConfirm: () => null,
  }
  registerRoutes({ ctx, runtime, version: '0.0.0-test' })
  try {
    await fn({ handlers, runtime, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function post(handler, body) {
  const res = { writeHead(status) { this.status = status }, end(b) { this.body = b } }
  handler({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, body }, res)
  return new Promise((resolve) => setTimeout(() => resolve(res), 30))
}

test('a tutorial can be written, listed and started through the routes', async () => {
  const { writeFile } = await import('node:fs/promises')
  await withRealRuntime(async ({ handlers, dir }) => {
    // readBody 从 req 流里读；这里用一个最小的可读流
    const { Readable } = await import('node:stream')
    const makeReq = (obj) => {
      const req = Readable.from([Buffer.from(JSON.stringify(obj))])
      req.method = 'POST'
      req.headers = { 'content-type': 'application/json' }
      return req
    }

    const saveRes = { writeHead(s2) { this.status = s2 }, end(b) { this.body = b } }
    handlers.get('/dsh-handeye-plus/tutorials/save')(makeReq({
      id: 'tut_demo',
      title: '演示教程',
      goal: '把这件事按三步做完',
      path: ['第一步', '第二步', '第三步'],
      verify: [{ type: 'file', path: 'out', minBytes: 1 }],
    }), saveRes)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(saveRes.status, 200, String(saveRes.body))

    const listRes = { writeHead(s2) { this.status = s2 }, end(b) { this.body = b } }
    handlers.get('/dsh-handeye-plus/tutorials')({ method: 'GET', url: '/dsh-handeye-plus/tutorials', headers: {} }, listRes)
    await new Promise((r) => setTimeout(r, 40))
    const listed = JSON.parse(listRes.body)
    assert.equal(listed.value.length, 1)
    assert.equal(listed.value[0].id, 'tut_demo')
    assert.equal(listed.value[0].path.length, 3)

    const runRes = { writeHead(s2) { this.status = s2 }, end(b) { this.body = b } }
    handlers.get('/dsh-handeye-plus/tutorials/run')(makeReq({ id: 'tut_demo' }), runRes)
    await new Promise((r) => setTimeout(r, 60))
    const run = JSON.parse(runRes.body)
    assert.equal(run.ok, true, run.error)
    assert.equal(run.stepCount, 3)
    assert.ok(run.goalId)
  })
})

test('writing a tutorial without steps is refused', async () => {
  const { Readable } = await import('node:stream')
  await withRealRuntime(async ({ handlers }) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ id: 'tut_bad', title: 'x', goal: 'y', path: [] }))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    const res = { writeHead(s2) { this.status = s2 }, end(b) { this.body = b } }
    handlers.get('/dsh-handeye-plus/tutorials/save')(req, res)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(res.status, 400)
    assert.match(String(res.body), /至少要写一个步骤/)
  })
})
