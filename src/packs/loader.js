// 领域包加载器：把一包"行业知识"装进本地。
//
// 领域包 = 判据 + 任务卡 + 技能模板。核心不随行业变，行业包由社区维护。
// 这里只做三件事：读、校验、装。任何一条不合格就整包不装（避免装一半的包）。

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { failure, success, ERR } from '../core/errors.js'
import { validateDomainPack } from '../formats/index.js'

const CHECK_PLACEHOLDER = /\{\{packCheck:([a-z0-9_-]+)\}\}/g

/** 把 {{packCheck:x}} 换成这个包里的真实脚本路径（仅本机安装时替换）。 */
export function substitutePackChecks(value, packDir) {
  if (typeof value === 'string') return value.replace(CHECK_PLACEHOLDER, (_, name) => path.join(packDir, 'checks', `${name}.mjs`))
  if (Array.isArray(value)) return value.map((v) => substitutePackChecks(v, packDir))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitutePackChecks(v, packDir)
    return out
  }
  return value
}

/** 读一个领域包目录（含 pack.json），并做格式校验。 */
export function loadPack(dir) {
  const packFile = path.join(dir, 'pack.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(packFile, 'utf8'))
  } catch (error) {
    return failure(ERR.NOT_FOUND, `读不到 ${packFile}：${error instanceof Error ? error.message : String(error)}`)
  }
  const shape = validateDomainPack(raw)
  if (!shape.ok) return failure(ERR.INVALID, `领域包格式不对：${shape.message}`)
  return success({ pack: raw, dir })
}

/**
 * 装一个领域包。
 * @param {string} dir 包目录
 * @param {{cards: object}} stores 只需要卡片仓库（技能模板以后再加）
 */
export async function installPack(dir, { cards } = {}) {
  const loaded = loadPack(dir)
  if (!loaded.ok) return loaded
  const { pack } = loaded.value

  const installed = []
  const failed = []

  for (const card of pack.cards ?? []) {
    if (!cards || typeof cards.importCard !== 'function') {
      failed.push({ id: card.id, message: '没有卡片仓库，无法安装' })
      continue
    }
    // 把包内脚本路径填进去，再补上卡片 schema 的必填默认值
    const prepared = {
      ...substitutePackChecks(card, dir),
      schemaVersion: 1,
      origin: 'imported',
      version: 1,
      delivery: card.delivery ?? 'start',
      autonomy: card.autonomy ?? 'supervised',
      constraints: card.constraints ?? [],
    }
    const result = await cards.importCard(prepared)
    if (result.ok) installed.push({ id: card.id, title: card.title })
    else failed.push({ id: card.id, message: result.message })
  }

  return success({
    pack: { name: pack.name, version: pack.version, description: pack.description },
    verifyTemplates: (pack.verify ?? []).length,
    installed,
    failed,
  })
}
