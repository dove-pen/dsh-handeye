// 数据打包与恢复。
//
// 目的只有一个：**让"归你"变成能点的按钮**。用户随时能把技能/目标/卡片打包带走，
// 或者从别处恢复回来。
//
// 两条硬规则：
//   1. 导入是"先全部校验，再落盘"：坏文件绝不改现有数据
//   2. 默认不覆盖：已存在的跳过并报告；要覆盖必须显式 --force

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

import { createCardStore } from '../memory/cards.js'
import { createGoalStore, validateGoal } from '../memory/goals.js'
import { createSkillStore } from '../memory/skillStore.js'
import { validateCard } from '../memory/schema.js'
import { validateSkill, FORMATS_VERSION } from '../formats/index.js'

export const BUNDLE_VERSION = 1

function readJsonDir(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')))
    } catch {
      // 坏文件跳过：打包不能因为一个坏文件整个失败
    }
  }
  return out
}

function listEpisodeLogs(dataDir) {
  const dir = path.join(dataDir, 'episodes')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((name) => ({ file: name, content: readFileSync(path.join(dir, name), 'utf8') }))
}

/**
 * 打包当前数据目录。
 * @returns {{bundle: object, counts: object, warnings: string[]}}
 */
export function exportBundle({ dataDir, includeLogs = false, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('exportBundle needs dataDir')

  const skills = readJsonDir(path.join(dataDir, 'skills'))
  const goals = readJsonDir(path.join(dataDir, 'goals'))
  const cards = readJsonDir(path.join(dataDir, 'cards'))
  const warnings = []

  // 打包时也校验一遍：坏的不要装进 bundle 里冒充好的
  const goodSkills = skills.filter((s) => {
    const ok = validateSkill(s).ok
    if (!ok) warnings.push(`skill ${s?.id ?? '?'} does not match the format; skipped`)
    return ok
  })
  const goodGoals = goals.filter((g) => {
    const ok = validateGoal(g).ok
    if (!ok) warnings.push(`goal ${g?.id ?? '?'} does not match the format; skipped`)
    return ok
  })
  const goodCards = cards.filter((c) => {
    const ok = validateCard(c).ok
    if (!ok) warnings.push(`card ${c?.id ?? '?'} does not match the format; skipped`)
    return ok
  })

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    formatsVersion: FORMATS_VERSION,
    exportedAt: now().toISOString(),
    // 偏好目前没有独立存储；留字段，将来填
    preferences: {},
    skills: goodSkills,
    goals: goodGoals,
    cards: goodCards,
    ...(includeLogs ? { logs: listEpisodeLogs(dataDir) } : {}),
  }

  const counts = {
    skills: goodSkills.length,
    goals: goodGoals.length,
    cards: goodCards.length,
    logs: includeLogs ? (bundle.logs ?? []).length : 0,
  }
  return { bundle, counts, warnings }
}

/** 只校验，不落盘：导入前的"体检"。 */
export function validateBundle(bundle) {
  const errors = []
  if (!bundle || typeof bundle !== 'object') return { ok: false, errors: ['not an object'] }
  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    errors.push(`bundleVersion is ${bundle.bundleVersion}; this version accepts ${BUNDLE_VERSION}`)
  }
  for (const key of ['skills', 'goals', 'cards']) {
    if (bundle[key] !== undefined && !Array.isArray(bundle[key])) errors.push(`${key} must be an array`)
  }
  if (errors.length) return { ok: false, errors }

  for (const skill of bundle.skills ?? []) {
    const shape = validateSkill(skill)
    if (!shape.ok) errors.push(`skill ${skill?.id ?? '?'}: ${shape.message}`)
  }
  for (const goal of bundle.goals ?? []) {
    const shape = validateGoal(goal)
    if (!shape.ok) errors.push(`goal ${goal?.id ?? '?'}: ${(shape.errors ?? []).map((e) => `${e.path} ${e.message}`).join('; ')}`)
  }
  for (const card of bundle.cards ?? []) {
    const shape = validateCard(card)
    if (!shape.ok) errors.push(`card ${card?.id ?? '?'}: ${(shape.errors ?? []).map((e) => `${e.path} ${e.message}`).join('; ')}`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 应用一个 bundle。
 * @returns {Promise<{ok:boolean, errors?:string[], plan?:object, applied?:object, warnings?:string[]}>}
 */
export async function importBundle({ dataDir, bundle, dryRun = false, force = false } = {}) {
  if (!dataDir) return { ok: false, errors: ['importBundle needs dataDir'] }
  const check = validateBundle(bundle)
  if (!check.ok) return { ok: false, errors: check.errors }

  // 判断"已存在"只读盘，不建目录：dry-run 必须是零副作用
  const idsIn = (bucket) => {
    const dir = path.join(dataDir, bucket)
    if (!existsSync(dir)) return new Set()
    return new Set(
      readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -'.json'.length)),
    )
  }
  const existingSkills = idsIn('skills')
  const existingGoals = idsIn('goals')
  const existingCards = idsIn('cards')

  const plan = { skills: [], goals: [], cards: [] }
  const classify = (items, existing, bucket) => {
    for (const item of items ?? []) {
      const state = existing.has(item.id) ? (force ? 'overwrite' : 'skip') : 'add'
      plan[bucket].push({ id: item.id, state })
    }
  }
  classify(bundle.skills, existingSkills, 'skills')
  classify(bundle.goals, existingGoals, 'goals')
  classify(bundle.cards, existingCards, 'cards')

  if (dryRun) return { ok: true, plan, warnings: [] }

  const warnings = []
  const applied = { skills: 0, goals: 0, cards: 0 }
  const cards = createCardStore({ dir: dataDir })
  const goals = createGoalStore({ dir: dataDir })
  const skills = createSkillStore({ dir: dataDir })

  for (const entry of plan.skills) {
    if (entry.state === 'skip') continue
    const skill = bundle.skills.find((s) => s.id === entry.id)
    const saved = await skills.save(skill)
    if (saved.ok) applied.skills += 1
    else warnings.push(`skill ${entry.id} could not be saved: ${saved.message}`)
  }

  for (const entry of plan.goals) {
    if (entry.state === 'skip') continue
    const goal = bundle.goals.find((g) => g.id === entry.id)
    const saved = await goals.save({ ...goal })
    if (saved.ok) applied.goals += 1
    else warnings.push(`goal ${entry.id} could not be saved: ${saved.message}`)
  }

  for (const entry of plan.cards) {
    if (entry.state === 'skip') continue
    const card = bundle.cards.find((c) => c.id === entry.id)
    if (entry.state === 'overwrite') await cards.remove(entry.id)
    const saved = await cards.importCard({ ...card, origin: 'imported' })
    if (saved.ok) applied.cards += 1
    else warnings.push(`card ${entry.id} could not be imported: ${saved.message}`)
  }

  // 日志：只写回文件，不做合并
  if (Array.isArray(bundle.logs) && bundle.logs.length) {
    const dir = path.join(dataDir, 'episodes')
    mkdirSync(dir, { recursive: true })
    for (const log of bundle.logs) {
      if (!log || typeof log.file !== 'string' || typeof log.content !== 'string') continue
      if (!/^[\w.-]+\.jsonl$/.test(log.file)) {
        warnings.push(`unsafe log file name; skipped: ${log.file}`)
        continue
      }
      writeFileSync(path.join(dir, log.file), log.content, 'utf8')
    }
  }

  return { ok: true, plan, applied, warnings }
}
