import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { exportBundle, importBundle, validateBundle, BUNDLE_VERSION } from '../../src/data/bundle.js'

function sampleSkill(id = 'skill_20261108_01') {
  return {
    schemaVersion: 1,
    id,
    title: '订阅一个邮件通讯',
    version: 1,
    origin: { kind: 'episode', episodeIds: ['a'], createdAt: '2026-11-08T00:00:00Z', author: 'local' },
    params: [{ name: 'url', required: true }],
    steps: [{ id: 's1', intent: '打开 {{url}}', tool: 'browser_navigate', args: {}, anchor: null, expect: null, onFail: 'stop' }],
    health: { runs: 0, ok: 0, fail: 0, failsInRow: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
    incomplete: { stepsWithoutChecks: 1, fragileSteps: 0 },
  }
}

function sampleGoal(id = 'goal_20261108_abcdef') {
  return {
    schemaVersion: 1,
    id,
    title: '整理发票',
    longTermGoal: '把一批发票按月份归档',
    status: 'active',
    steps: [],
    runs: [],
    createdAt: '2026-11-08T00:00:00Z',
    updatedAt: '2026-11-08T00:00:00Z',
  }
}

function sampleCard(id = 'demo_card') {
  return {
    schemaVersion: 1,
    id,
    title: '演示卡片',
    origin: 'imported',
    version: 1,
    delivery: 'start',
    autonomy: 'supervised',
    goal: '验证打包能带上卡片',
    path: ['第一步'],
    constraints: [],
    success: '卡片出现在目标目录',
    createdAt: '2026-11-08T00:00:00Z',
    updatedAt: '2026-11-08T00:00:00Z',
    enabled: true,
  }
}

async function seed(dataDir, { skill = true, goal = true, card = true } = {}) {
  if (skill) {
    await mkdir(path.join(dataDir, 'skills'), { recursive: true })
    await writeFile(path.join(dataDir, 'skills', 'skill_20261108_01.json'), JSON.stringify(sampleSkill(), null, 2), 'utf8')
  }
  if (goal) {
    await mkdir(path.join(dataDir, 'goals'), { recursive: true })
    await writeFile(path.join(dataDir, 'goals', 'goal_20261108_abcdef.json'), JSON.stringify(sampleGoal(), null, 2), 'utf8')
  }
  if (card) {
    await mkdir(path.join(dataDir, 'cards'), { recursive: true })
    await writeFile(path.join(dataDir, 'cards', 'demo_card.json'), JSON.stringify(sampleCard(), null, 2), 'utf8')
  }
}

async function tempDirs(count = 1) {
  const dirs = []
  for (let i = 0; i < count; i += 1) dirs.push(await mkdtemp(path.join(tmpdir(), 'bundle-')))
  return dirs
}

// ---------------------------------------------------------------- export

test('an empty data dir exports an empty bundle', async () => {
  const [dir] = await tempDirs()
  try {
    const { bundle, counts } = exportBundle({ dataDir: dir })
    assert.equal(bundle.bundleVersion, BUNDLE_VERSION)
    assert.deepEqual(counts, { skills: 0, goals: 0, cards: 0, logs: 0 })
    assert.ok(bundle.exportedAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('export picks up skills, goals and cards', async () => {
  const [dir] = await tempDirs()
  try {
    await seed(dir)
    const { bundle, counts, warnings } = exportBundle({ dataDir: dir })
    assert.deepEqual(counts, { skills: 1, goals: 1, cards: 1, logs: 0 })
    assert.deepEqual(warnings, [])
    assert.equal(bundle.skills[0].id, 'skill_20261108_01')
    assert.equal(bundle.goals[0].id, 'goal_20261108_abcdef')
    assert.equal(bundle.cards[0].id, 'demo_card')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed file is skipped with a warning, not packed as-is', async () => {
  const [dir] = await tempDirs()
  try {
    await mkdir(path.join(dir, 'skills'), { recursive: true })
    await writeFile(path.join(dir, 'skills', 'bad.json'), JSON.stringify({ id: 'skill_20261108_99' }), 'utf8')
    const { counts, warnings } = exportBundle({ dataDir: dir })
    assert.equal(counts.skills, 0)
    assert.match(warnings.join(' '), /不符合格式/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('logs are only included on request', async () => {
  const [dir] = await tempDirs()
  try {
    await mkdir(path.join(dir, 'episodes'), { recursive: true })
    await writeFile(path.join(dir, 'episodes', '2026-11-08.jsonl'), '{"id":"ep_1"}\n', 'utf8')
    assert.equal(exportBundle({ dataDir: dir }).counts.logs, 0)
    const withLogs = exportBundle({ dataDir: dir, includeLogs: true })
    assert.equal(withLogs.counts.logs, 1)
    assert.equal(withLogs.bundle.logs[0].file, '2026-11-08.jsonl')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- validate + import

test('validateBundle rejects a wrong version and bad items', () => {
  assert.equal(validateBundle({ bundleVersion: 99 }).ok, false)
  const withBadSkill = { bundleVersion: BUNDLE_VERSION, skills: [{ id: 'x' }], goals: [], cards: [] }
  const shape = validateBundle(withBadSkill)
  assert.equal(shape.ok, false)
  assert.match(shape.errors.join(' '), /技能 x/)
})

test('round trip: export from one dir, import into an empty one', async () => {
  const [from, to] = await tempDirs(2)
  try {
    await seed(from)
    const { bundle } = exportBundle({ dataDir: from })
    const result = await importBundle({ dataDir: to, bundle })
    assert.equal(result.ok, true, (result.errors ?? []).join('；'))
    assert.deepEqual(result.applied, { skills: 1, goals: 1, cards: 1 })

    const again = exportBundle({ dataDir: to })
    assert.deepEqual(again.counts, { skills: 1, goals: 1, cards: 1, logs: 0 })
    assert.equal(again.bundle.skills[0].title, '订阅一个邮件通讯')
    assert.equal(again.bundle.goals[0].title, '整理发票')
    assert.equal(again.bundle.cards[0].title, '演示卡片')
  } finally {
    for (const d of [from, to]) await rm(d, { recursive: true, force: true })
  }
})

test('a bad bundle changes nothing on disk', async () => {
  const [from, to] = await tempDirs(2)
  try {
    await seed(to)
    const before = await readdir(path.join(to, 'skills'))
    const bad = { bundleVersion: BUNDLE_VERSION, skills: [{ id: 'nope' }], goals: [], cards: [] }
    const result = await importBundle({ dataDir: to, bundle: bad })
    assert.equal(result.ok, false)
    assert.match(result.errors.join(' '), /技能 nope/)
    const after = await readdir(path.join(to, 'skills'))
    assert.deepEqual(after, before, '校验失败不许动任何文件')
  } finally {
    for (const d of [from, to]) await rm(d, { recursive: true, force: true })
  }
})

test('existing items are skipped by default and overwritten with --force', async () => {
  const [from, to] = await tempDirs(2)
  try {
    await seed(from)
    await seed(to)
    const { bundle } = exportBundle({ dataDir: from })

    const skipped = await importBundle({ dataDir: to, bundle })
    assert.equal(skipped.ok, true)
    assert.equal(skipped.applied.skills, 0)
    assert.ok(skipped.plan.skills.every((p) => p.state === 'skip'))

    const forced = await importBundle({ dataDir: to, bundle, force: true })
    assert.equal(forced.applied.skills, 1)
    assert.ok(forced.plan.skills.every((p) => p.state === 'overwrite'))
  } finally {
    for (const d of [from, to]) await rm(d, { recursive: true, force: true })
  }
})

test('--dry-run reports the plan without writing', async () => {
  const [from, to] = await tempDirs(2)
  try {
    await seed(from)
    const { bundle } = exportBundle({ dataDir: from })
    const result = await importBundle({ dataDir: to, bundle, dryRun: true })
    assert.equal(result.ok, true)
    assert.equal(result.applied, undefined)
    assert.ok(result.plan.skills.some((p) => p.state === 'add'))
    await assert.rejects(readdir(path.join(to, 'skills')))
  } finally {
    for (const d of [from, to]) await rm(d, { recursive: true, force: true })
  }
})

test('logs travel with the bundle and unsafe names are refused', async () => {
  const [from, to] = await tempDirs(2)
  try {
    await mkdir(path.join(from, 'episodes'), { recursive: true })
    await writeFile(path.join(from, 'episodes', '2026-11-08.jsonl'), '{"id":"ep_1"}\n', 'utf8')
    const { bundle } = exportBundle({ dataDir: from, includeLogs: true })
    bundle.logs.push({ file: '../evil.jsonl', content: 'x' })

    const result = await importBundle({ dataDir: to, bundle })
    assert.equal(result.ok, true)
    const written = await readFile(path.join(to, 'episodes', '2026-11-08.jsonl'), 'utf8')
    assert.match(written, /ep_1/)
    assert.match(result.warnings.join(' '), /不安全/)
  } finally {
    for (const d of [from, to]) await rm(d, { recursive: true, force: true })
  }
})
