// Goal store: the long-running container above task cards.
//
// A card answers "do this one thing". A goal answers "where are we going, what
// are the steps, which step are we on, and what happened last time".
// One goal = one JSON file, so a corrupted file costs one goal, not the store.
//
// Pure-ish: all I/O is behind the injected dir/now, so tests drive it with a
// temp directory and a frozen clock.

import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { ERR, failure, success } from '../core/errors.js'

export const GOAL_STATUS = ['active', 'paused', 'done', 'archived']
export const STEP_STATUS = ['todo', 'doing', 'blocked', 'done', 'skipped']

/** 会写盘的方法：这些必须串行执行。 */
const MUTATORS = ['setPlan', 'enterStep', 'finishStep', 'blockStep', 'skipStep', 'recordVerifyFailure', 'appendRun', 'setStatus', 'remove']

export const MAX_STEPS = 20
export const MAX_TITLE = 80
export const MAX_LONG_GOAL = 2000
export const DEFAULT_STEP_BUDGET = 8 // actions per step; soft limit, see gate.js

const ID_RE = /^goal_[a-z0-9_]{4,40}$/

function nowIso(now) {
  return new Date(now()).toISOString()
}

/** goal_20261107_a1b2c3 - sortable by date, short enough to read out loud. */
export function newGoalId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0')
  return `goal_${stamp}_${rand}`
}

function isNonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a goal document. Kept next to the store instead of schema.js because
 * goals are not cards: different lifecycle, different fields.
 */
export function validateGoal(doc) {
  const errors = []
  const add = (at, message) => errors.push({ path: at, message })

  if (!isPlainObject(doc)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (doc.schemaVersion !== 1) add('schemaVersion', 'must be 1')
  if (!ID_RE.test(String(doc.id ?? ''))) add('id', 'must look like goal_YYYYMMDD_xxxxxx')
  if (!isNonEmptyString(doc.title, MAX_TITLE)) add('title', `must be 1-${MAX_TITLE} chars`)
  if (!isNonEmptyString(doc.longTermGoal, MAX_LONG_GOAL)) add('longTermGoal', `must be 1-${MAX_LONG_GOAL} chars`)
  if (!GOAL_STATUS.includes(doc.status)) add('status', `must be one of: ${GOAL_STATUS.join(', ')}`)

  if (!Array.isArray(doc.steps)) {
    add('steps', 'must be an array')
  } else {
    if (doc.steps.length > MAX_STEPS) add('steps', `must be at most ${MAX_STEPS} steps`)
    const seen = new Set()
    let doing = 0
    doc.steps.forEach((step, index) => {
      const at = `steps[${index}]`
      if (!isPlainObject(step)) {
        add(at, 'must be an object')
        return
      }
      if (!isNonEmptyString(step.id, 20)) add(`${at}.id`, 'must be a short id')
      else if (seen.has(step.id)) add(`${at}.id`, 'duplicate step id')
      else seen.add(step.id)
      if (!isNonEmptyString(step.title, 200)) add(`${at}.title`, 'must be 1-200 chars')
      if (!STEP_STATUS.includes(step.status)) add(`${at}.status`, `must be one of: ${STEP_STATUS.join(', ')}`)
      if (step.status === 'doing') doing += 1
      if (step.budget !== undefined && (!isPlainObject(step.budget) || !Number.isInteger(step.budget.actions) || step.budget.actions < 1)) {
        add(`${at}.budget`, 'must be { actions: positive integer }')
      }
      if (step.verify !== null && step.verify !== undefined && !Array.isArray(step.verify)) {
        add(`${at}.verify`, 'must be an array or null')
      }
    })
    // The whole design leans on "one step at a time"; two doing steps means the
    // file got edited behind our back and every gate decision is now ambiguous.
    if (doing > 1) add('steps', 'at most one step may be "doing"')
  }

  if (doc.runs !== undefined && !Array.isArray(doc.runs)) add('runs', 'must be an array')
  return { ok: errors.length === 0, errors }
}

export function createGoalStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new TypeError('createGoalStore requires dir')
  const goalDir = path.join(dir, 'goals')

  async function ensureDir() {
    await mkdir(goalDir, { recursive: true })
  }

  function fileOf(id) {
    return path.join(goalDir, `${id}.json`)
  }

  let tmpSeq = 0
  const writeQueues = new Map()

  /** 同一个目标的写操作排队执行；上一个失败也不会卡住后面。 */
  function enqueue(key, job) {
    const prev = writeQueues.get(key) || Promise.resolve()
    const next = prev.then(job, job)
    writeQueues.set(key, next.catch(() => {}))
    return next
  }

  async function writeDoc(doc) {
    await ensureDir()
    await mkdir(goalDir, { recursive: true })
    const file = fileOf(doc.id)
    // 每个写手用自己唯一的临时文件：共用 <id>.json.tmp 时，一个 rename 会把
    // 另一个正要 rename 的临时文件抢走，直接 ENOENT 崩掉（实测并发写复现）。
    const tmp = `${file}.${process.pid}.${(tmpSeq += 1)}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async function get(id) {
    const key = String(id ?? '')
    if (!ID_RE.test(key)) return failure(ERR.NOT_FOUND, `Invalid goal id: ${key}`)
    try {
      const doc = JSON.parse(await readFile(fileOf(key), 'utf8'))
      const check = validateGoal(doc)
      if (!check.ok) return failure(ERR.INTERNAL, 'Stored goal is invalid', check.errors)
      return success(doc)
    } catch (error) {
      if (error.code === 'ENOENT') return failure(ERR.NOT_FOUND, `Goal "${key}" not found`)
      return failure(ERR.INTERNAL, `Goal read failed: ${error.message}`)
    }
  }

  async function list({ status } = {}) {
    try {
      await ensureDir()
      const names = (await readdir(goalDir)).filter((n) => n.endsWith('.json'))
      const out = []
      for (const file of names) {
        try {
          const doc = JSON.parse(await readFile(path.join(goalDir, file), 'utf8'))
          if (!validateGoal(doc).ok) continue
          if (status && doc.status !== status) continue
          out.push(doc)
        } catch {
          // one broken file must not hide the rest
        }
      }
      out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      return success(out)
    } catch (error) {
      return failure(ERR.INTERNAL, `Goal list failed: ${error.message}`)
    }
  }

  async function create({ title, longTermGoal, steps = [], meta = null } = {}) {
    const id = newGoalId(new Date(now()))
    const stamp = nowIso(now)
    const doc = {
      schemaVersion: 1,
      id,
      title: String(title ?? '').trim(),
      longTermGoal: String(longTermGoal ?? '').trim(),
      status: 'active',
      steps: normalizeSteps(steps),
      // 来源信息（例如由哪份技能编译而来）。validateGoal 不禁止额外字段。
      meta: isPlainObject(meta) ? meta : null,
      runs: [],
      createdAt: stamp,
      updatedAt: stamp,
    }
    const check = validateGoal(doc)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Goal is invalid', check.errors)
    await writeDoc(doc)
    return success(doc)
  }

  /** Replace the step list entirely. Ids are positional (s1..sn) on purpose:
   *  they are referenced by runs and by the user's "第 N 步", not by content. */
  async function setPlan(id, steps) {
    const current = await get(id)
    if (!current.ok) return current
    const doc = { ...current.value, steps: normalizeSteps(steps), updatedAt: nowIso(now) }
    const check = validateGoal(doc)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Plan is invalid', check.errors)
    await writeDoc(doc)
    return success(doc)
  }

  async function save(doc) {
    const check = validateGoal(doc)
    if (!check.ok) return failure(ERR.CARD_INVALID, 'Goal is invalid', check.errors)
    const next = { ...doc, updatedAt: nowIso(now) }
    await writeDoc(next)
    return success(next)
  }

  /** Enter a step. Refuses if another step is still running. */
  async function enterStep(id, stepId, patch = {}) {
    const current = await get(id)
    if (!current.ok) return current
    const doc = current.value
    if (doc.status !== 'active') return failure(ERR.PAUSED, `Goal is ${doc.status}`)
    const running = doc.steps.find((s) => s.status === 'doing')
    if (running && running.id !== stepId) {
      return failure(ERR.TOOL_NOT_ALLOWED, `Step "${running.id}" is still running; finish or block it first`)
    }
    const step = doc.steps.find((s) => s.id === stepId)
    if (!step) return failure(ERR.NOT_FOUND, `Step "${stepId}" not found`)
    if (step.status === 'done') return failure(ERR.TOOL_NOT_ALLOWED, `Step "${stepId}" is already done`)

    const next = {
      ...step,
      status: 'doing',
      attempts: Number(step.attempts ?? 0) + 1,
      doneAt: null,
      // 重进就是重新开始：不清零的话，上轮的失败次数会把这一轮直接判成 blocked
      verifyFailures: 0,
      promptId: patch.promptId !== undefined ? patch.promptId : step.promptId,
      verify: patch.verify !== undefined ? patch.verify : step.verify,
      budget: patch.budget ?? step.budget ?? { actions: DEFAULT_STEP_BUDGET },
    }
    const steps = doc.steps.map((s) => (s.id === stepId ? next : s))
    const saved = await save({ ...doc, steps })
    return saved.ok ? success({ goal: saved.value, step: next }) : saved
  }

  async function updateStep(id, stepId, mutate) {
    const current = await get(id)
    if (!current.ok) return current
    const doc = current.value
    const step = doc.steps.find((s) => s.id === stepId)
    if (!step) return failure(ERR.NOT_FOUND, `Step "${stepId}" not found`)
    const next = mutate({ ...step }) ?? step
    const steps = doc.steps.map((s) => (s.id === stepId ? next : s))
    const saved = await save({ ...doc, steps })
    return saved.ok ? success({ goal: saved.value, step: next }) : saved
  }

  async function finishStep(id, stepId, { result = 'ok', evidence = [] } = {}) {
    return updateStep(id, stepId, (step) => ({
      ...step,
      status: 'done',
      doneAt: nowIso(now),
      evidence: [...(step.evidence ?? []), ...evidence].slice(-20),
      verifyFailures: 0,
      lastResult: String(result),
    }))
  }

  async function blockStep(id, stepId, reason) {
    return updateStep(id, stepId, (step) => ({
      ...step,
      status: 'blocked',
      blocks: [...(step.blocks ?? []), { at: nowIso(now), reason: String(reason ?? '') }].slice(-10),
    }))
  }

  async function skipStep(id, stepId, reason) {
    return updateStep(id, stepId, (step) => ({
      ...step,
      status: 'skipped',
      doneAt: nowIso(now),
      blocks: [...(step.blocks ?? []), { at: nowIso(now), reason: `skipped: ${String(reason ?? '')}` }].slice(-10),
    }))
  }

  /** Count one failed acceptance check; the second one blocks the step. */
  async function recordVerifyFailure(id, stepId, detail = '') {
    const current = await get(id)
    if (!current.ok) return current
    const step = current.value.steps.find((s) => s.id === stepId)
    if (!step) return failure(ERR.NOT_FOUND, `Step "${stepId}" not found`)
    const failures = Number(step.verifyFailures ?? 0) + 1
    const blocked = failures >= 2
    const updated = await updateStep(id, stepId, (s) => ({
      ...s,
      verifyFailures: failures,
      status: blocked ? 'blocked' : s.status,
      blocks: blocked ? [...(s.blocks ?? []), { at: nowIso(now), reason: `verify failed twice: ${detail}` }].slice(-10) : s.blocks,
    }))
    return updated.ok ? success({ failures, blocked, step: updated.value.step, goal: updated.value.goal }) : updated
  }

  async function appendRun(id, run) {
    const current = await get(id)
    if (!current.ok) return current
    const doc = current.value
    const runs = [...(doc.runs ?? []), { at: nowIso(now), ...run }].slice(-100)
    return save({ ...doc, runs })
  }

  async function setStatus(id, status) {
    if (!GOAL_STATUS.includes(status)) return failure(ERR.CARD_INVALID, `Unknown status: ${status}`)
    const current = await get(id)
    if (!current.ok) return current
    return save({ ...current.value, status })
  }

  async function remove(id) {
    const current = await get(id)
    if (!current.ok) return current
    try {
      await unlink(fileOf(id))
      return success({ id })
    } catch (error) {
      return failure(ERR.INTERNAL, `Goal delete failed: ${error.message}`)
    }
  }

  const store = {
    get,
    list,
    create,
    save,
    setPlan,
    enterStep,
    finishStep,
    blockStep,
    skipStep,
    recordVerifyFailure,
    appendRun,
    setStatus,
    remove,
    dir: goalDir,
  }

  // 串行化同一个目标的读-改-写。不同目标互不影响。
  for (const name of MUTATORS) {
    const run = store[name].bind(store)
    store[name] = (id, ...rest) => enqueue(String(id ?? ''), () => run(id, ...rest))
  }
  return store
}

/** Accepts ["第一步", ...] or [{ title, promptId?, verify? }, ...]. */
export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return []
  return steps
    .slice(0, MAX_STEPS)
    .map((raw, index) => {
      const base = typeof raw === 'string' ? { title: raw } : isPlainObject(raw) ? raw : null
      if (!base) return null
      const title = String(base.title ?? '').trim()
      if (!title) return null
      return {
        id: `s${index + 1}`,
        title: title.slice(0, 200),
        status: 'todo',
        promptId: base.promptId ? String(base.promptId) : null,
        verify: Array.isArray(base.verify) ? base.verify : null,
        budget: isPlainObject(base.budget) && Number.isInteger(base.budget.actions)
          ? { actions: Math.min(Math.max(base.budget.actions, 1), 40) }
          : { actions: DEFAULT_STEP_BUDGET },
        attempts: 0,
        verifyFailures: 0,
        blocks: [],
        evidence: [],
        doneAt: null,
      }
    })
    .filter(Boolean)
}

/** Compact "第 2/5 步" progress summary for status output. */
export function summarizeGoal(doc) {
  const steps = Array.isArray(doc?.steps) ? doc.steps : []
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const doing = steps.find((s) => s.status === 'doing')
  const blocked = steps.find((s) => s.status === 'blocked')
  return {
    id: doc?.id ?? '',
    title: doc?.title ?? '',
    status: doc?.status ?? '',
    total: steps.length,
    done,
    doing: doing ? doing.id : null,
    blocked: blocked ? blocked.id : null,
    next: (steps.find((s) => s.status === 'todo') ?? null)?.id ?? null,
  }
}
