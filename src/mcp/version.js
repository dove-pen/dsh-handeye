// 版本号的单一来源：serverInfo 和 CLI 都读这里，避免两处漂移。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()
