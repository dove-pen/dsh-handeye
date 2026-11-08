// 公共格式在插件里的入口。
//
// schemas/ 与 validate.js 都是从 dsh-handeye-formats 复制来的（见 tools/sync-formats.mjs）。
// 插件只做两件事：读 schema、对着它校验。规则本身不在这里。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validate, summarize } from './validate.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export const FORMATS_VERSION = '1.1.0'

function load(name) {
  return JSON.parse(readFileSync(path.join(here, 'schemas', name), 'utf8'))
}

export const schemas = {
  skill: load('skill.schema.json'),
  verify: load('verify.schema.json'),
  domainPack: load('domain-pack.schema.json'),
}

export function validateSkill(skill) {
  const errors = validate(schemas.skill, skill)
  return { ok: errors.length === 0, errors, message: summarize(errors) }
}

export function validateVerify(checks) {
  const errors = validate(schemas.verify, checks)
  return { ok: errors.length === 0, errors, message: summarize(errors) }
}

export function validateDomainPack(pack) {
  const errors = validate(schemas.domainPack, pack)
  return { ok: errors.length === 0, errors, message: summarize(errors) }
}