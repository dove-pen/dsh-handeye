// 技能库：草案落盘 + 健康度记账。
//
// 健康度必须从第一天就有，否则几年后没人知道哪个技能已经烂了。
// 现在只做"存 + 记一次运行"，执行引擎在未来 —— 但字段和口径先定死。

import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { failure, success, ERR } from '../core/errors.js'
import { validateSkill } from '../formats/index.js'

const MAX_TITLE = 120
const SKILL_ID_RE = /^skill_\d{8}_\d{2}$/

export function createSkillStore({ dir }) {
  const skillDir = path.join(dir, 'skills')
  let seq = 0

  async function ensureDir() {
    await mkdir(skillDir, { recursive: true })
  }

  const fileOf = (id) => path.join(skillDir, `${id}.json`)

  async function writeDoc(doc) {
    await ensureDir()
    const file = fileOf(doc.id)
    const tmp = `${file}.${process.pid}.${(seq += 1)}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async function list() {
    try {
      await ensureDir()
      const names = (await readdir(skillDir)).filter((n) => n.endsWith('.json'))
      const out = []
      for (const name of names) {
        try {
          const doc = JSON.parse(await readFile(path.join(skillDir, name), 'utf8'))
          if (doc && SKILL_ID_RE.test(String(doc.id ?? ''))) out.push(doc)
        } catch {
          // 坏文件跳过，不让一个手改坏的 JSON 搞挂整个库
        }
      }
      out.sort((a, b) => String(b.origin?.createdAt ?? '').localeCompare(String(a.origin?.createdAt ?? '')))
      return success(out)
    } catch (error) {
      return failure(ERR.IO, error instanceof Error ? error.message : String(error))
    }
  }

  async function get(id) {
    try {
      const doc = JSON.parse(await readFile(fileOf(String(id)), 'utf8'))
      return success(doc)
    } catch {
      return failure(ERR.NOT_FOUND, `Skill not found: ${id}`)
    }
  }

  /** 存一份草案。同 id 覆盖（重新编译），并把版本号 +1。 */
  async function save(draft) {
    if (!draft || !SKILL_ID_RE.test(String(draft.id ?? ''))) {
      return failure(ERR.INVALID, 'invalid skill id')
    }
    if (!String(draft.title ?? '').trim() || String(draft.title).length > MAX_TITLE) {
      return failure(ERR.INVALID, `title must be 1-${MAX_TITLE} chars`)
    }
    // 格式校验放在这里：不合格的技能写不进库，别等半年后才发现字段对不上
    const shape = validateSkill(draft)
    if (!shape.ok) return failure(ERR.INVALID, `skill format: ${shape.message}`)
    const existing = await get(draft.id)
    const version = existing.ok ? Number(existing.value.version ?? 1) + 1 : Number(draft.version ?? 1)
    const doc = { ...draft, version, updatedAt: new Date().toISOString() }
    await writeDoc(doc)
    return success(doc)
  }

  /**
   * 记一次执行结果。健康度就在这一个入口上，别处不许改。
   * @param {'success'|'failure'} outcome
   */
  async function recordRun(id, { outcome = 'success', reason = null, now = new Date() } = {}) {
    const found = await get(id)
    if (!found.ok) return found
    const doc = found.value
    const health = { ...(doc.health ?? {}) }
    health.runs = Number(health.runs ?? 0) + 1
    if (outcome === 'success') health.ok = Number(health.ok ?? 0) + 1
    else health.fail = Number(health.fail ?? 0) + 1
    health.lastRunAt = now.toISOString()
    if (outcome !== 'success') health.lastFailReason = String(reason ?? '').slice(0, 200)

    const failsInRow = outcome === 'success' ? 0 : Number(health.failsInRow ?? 0) + 1
    health.failsInRow = failsInRow
    // 口径：连续 3 次失败 -> broken；成功率低于 90% 且有失败 -> needs-review
    const rate = health.runs > 0 ? health.ok / health.runs : 0
    health.status = failsInRow >= 3 ? 'broken' : health.fail > 0 && rate < 0.9 ? 'needs-review' : 'healthy'

    const saved = await save({ ...doc, health })
    return saved
  }

  async function remove(id) {
    try {
      await unlink(fileOf(String(id)))
      return success(true)
    } catch {
      return failure(ERR.NOT_FOUND, `Skill not found: ${id}`)
    }
  }

  return { list, get, save, recordRun, remove, dir: skillDir }
}
