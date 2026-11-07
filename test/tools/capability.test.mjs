import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCapabilityStore } from '../../src/memory/capabilities.js'
import { createConfirmStore } from '../../src/runtime/confirm.js'
import { createCapabilityTool } from '../../src/tools/capability.js'
import { beginEpisode, createState } from '../../src/core/state.js'

function cap(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'check_balance',
    title: '查余额',
    risk: 'read',
    status: 'draft',
    params: {},
    preconditions: [],
    steps: [{ op: 'read_text', as: 'text' }],
    postconditions: [],
    outputs: ['text'],
    ...overrides,
  }
}

async function setup({ overrides = {}, executorResult, episode = null, activeEpisode = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-he-cap-tool-'))
  const store = createCapabilityStore({ dir })
  const confirm = createConfirmStore()
  const state = createState()
  beginEpisode(state, 'test')
  const calls = []
  const executor = {
    async run(capability, params, options) {
      calls.push({ capability, params, options })
      return executorResult ?? { ok: true, value: { balance: '18.21' }, trace: [{ index: 0, op: 'read_text', ok: true, ms: 5 }], assumptions: {} }
    },
  }
  const episodes = {
    read: async (id) => (episode ? { ok: true, value: episode } : { ok: false, code: 'NOT_FOUND', message: 'missing' }),
    list: async () => ({ ok: true, value: episode ? [episode] : [] }),
  }
  const tool = createCapabilityTool({ state, store, executor, confirm, episodes, getActiveEpisode: () => activeEpisode })
  const saved = await store.saveDraft(cap(overrides))
  assert.equal(saved.ok, true)
  await store.enable(overrides.name ?? 'check_balance')
  return { dir, store, confirm, tool, calls, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('list and show expose capability state', async () => {
  const { tool, cleanup } = await setup()
  try {
    const list = await tool.execute({ action: 'list' })
    assert.match(list, /check_balance/)
    assert.match(list, /enabled/)
    const show = await tool.execute({ action: 'show', name: 'check_balance' })
    assert.equal(JSON.parse(show).name, 'check_balance')
  } finally {
    await cleanup()
  }
})

test('the first read run needs a user grant and is then remembered', async () => {
  const { tool, confirm, store, calls, cleanup } = await setup()
  try {
    const refused = await tool.execute({ action: 'run', name: 'check_balance', params: {} })
    assert.match(refused, /CONFIRM_REQUIRED/)
    assert.equal(calls.length, 0)

    confirm.grant('check_balance', 'read')
    const ran = await tool.execute({ action: 'run', name: 'check_balance', params: {} })
    assert.match(ran, /succeeded/)
    assert.match(ran, /18\.21/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.confirmed, true)

    const doc = await store.get('check_balance')
    assert.equal(doc.value.firstRunConfirmed, true)
    assert.equal(doc.value.stats.runs, 1)
    assert.equal(doc.value.stats.success, 1)

    const again = await tool.execute({ action: 'run', name: 'check_balance', params: {} })
    assert.match(again, /succeeded/)
    assert.equal(calls.length, 2)
  } finally {
    await cleanup()
  }
})

test('write capabilities need a grant on every run', async () => {
  const { tool, confirm, calls, cleanup } = await setup({
    overrides: { name: 'click_button', title: 'click', risk: 'write' },
  })
  try {
    const refused = await tool.execute({ action: 'run', name: 'click_button', params: {} })
    assert.match(refused, /CONFIRM_REQUIRED/)
    assert.equal(calls.length, 0)

    confirm.grant('click_button', 'write')
    const first = await tool.execute({ action: 'run', name: 'click_button', params: {} })
    assert.match(first, /succeeded/)

    const second = await tool.execute({ action: 'run', name: 'click_button', params: {} })
    assert.match(second, /CONFIRM_REQUIRED/)
    assert.equal(calls.length, 1)
  } finally {
    await cleanup()
  }
})

test('disabled capabilities are refused', async () => {
  const { tool, store, cleanup } = await setup()
  try {
    await store.disable('check_balance')
    const out = await tool.execute({ action: 'run', name: 'check_balance' })
    assert.match(out, /disabled/)
  } finally {
    await cleanup()
  }
})

test('capability save compiles the active episode into a draft', async () => {
  const episode = {
    id: 'ep_test',
    startedAt: '2026-11-07T10:00:00+08:00',
    outcome: 'success',
    steps: [
      { tool: 'hand_focus', args: { title: 'Chrome' }, ok: true },
      { tool: 'hand_click_text', args: { text: '登录' }, ok: true },
    ],
  }
  const { tool, store, cleanup } = await setup({ episode, activeEpisode: episode })
  try {
    const out = await tool.execute({ action: 'save', name: 'focus_and_click', title: 'focus and click' })
    assert.match(out, /Draft "focus_and_click" saved/)
    const doc = await store.get('focus_and_click')
    assert.equal(doc.ok, true)
    assert.equal(doc.value.status, 'draft')
    assert.equal(doc.value.fromEpisode, 'ep_test')
    assert.equal(doc.value.steps.length, 2)
  } finally {
    await cleanup()
  }
})

test('capability save without an episode explains what is missing', async () => {
  const { tool, cleanup } = await setup()
  try {
    const out = await tool.execute({ action: 'save', name: 'nothing_here', title: 'nothing' })
    assert.match(out, /no episode/i)
  } finally {
    await cleanup()
  }
})

test('failures are recorded with details', async () => {
  const { tool, confirm, store, cleanup } = await setup({
    executorResult: { ok: false, code: 'STEP_FAILED', message: 'Step 2 failed: not found', details: { step: 1 } },
  })
  try {
    confirm.grant('check_balance', 'read')
    const out = await tool.execute({ action: 'run', name: 'check_balance' })
    assert.match(out, /capability run failed/)
    assert.match(out, /"step": 1/)

    const doc = await store.get('check_balance')
    assert.equal(doc.value.stats.runs, 1)
    assert.equal(doc.value.stats.success, 0)
    assert.match(doc.value.stats.lastError, /Step 2 failed/)
  } finally {
    await cleanup()
  }
})
