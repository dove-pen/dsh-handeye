// Verification engine: turn "I think I'm done" into a machine check.
//
// Why this exists: episode_checkpoint used to advance the path with no check at
// all, so a model could claim a step was done and move on. Every acceptance
// criterion here is something a program can answer - file exists, text appears,
// command exits 0 - never "is the writing any good".
//
// Pure by design: the checker itself does no I/O. Everything that touches the
// world arrives as a dependency, so the whole engine is testable without a
// screen, a filesystem, or a shell.

export const VERIFY_TYPES = ['file', 'text', 'screen', 'exit', 'changed']

const MAX_CHECKS = 8
const MAX_TIMEOUT_MS = 120000

// Command prefixes allowed in a verify rule. A card is data, and cards can be
// imported from strangers, so "run any command" is not a thing here.
export const COMMAND_ALLOWLIST = ['node', 'npm', 'npx', 'git', 'dir', 'type', 'echo', 'findstr']

// ---------------------------------------------------------------- variables

const VAR_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g

function lookup(vars, dotted) {
  const parts = String(dotted).split('.')
  let cur = vars
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * Replace {{name}} / {{goal.title}} with values from `vars`.
 * Unresolved variables are an error, not an empty string: silently blanking a
 * path would make a check pass against the wrong file.
 * @returns {{ok:boolean, value:string, missing:string[]}}
 */
export function substitute(template, vars = {}) {
  const text = String(template ?? '')
  const missing = []
  const value = text.replace(VAR_RE, (match, name) => {
    const found = lookup(vars, name)
    if (found === undefined || found === null) {
      missing.push(name)
      return match
    }
    return String(found)
  })
  return { ok: missing.length === 0, value, missing: [...new Set(missing)] }
}

// ---------------------------------------------------------------- validation

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/**
 * Validate and normalise a verify array from a card (or a step override).
 * Returns a fresh array; the input is never mutated.
 */
export function normalizeChecks(raw) {
  const errors = []
  const add = (path, message) => errors.push({ path, message })

  if (!Array.isArray(raw)) {
    return { ok: false, errors: [{ path: 'verify', message: 'must be an array' }], checks: [] }
  }
  if (raw.length === 0 || raw.length > MAX_CHECKS) {
    return { ok: false, errors: [{ path: 'verify', message: `must contain 1-${MAX_CHECKS} checks` }], checks: [] }
  }

  const checks = []
  raw.forEach((item, index) => {
    const at = `verify[${index}]`
    if (!isPlainObject(item)) {
      add(at, 'must be an object')
      return
    }
    const type = String(item.type ?? '')
    if (!VERIFY_TYPES.includes(type)) {
      add(`${at}.type`, `must be one of: ${VERIFY_TYPES.join(', ')}`)
      return
    }

    const check = { type }
    if (item.timeoutMs !== undefined) {
      if (typeof item.timeoutMs !== 'number' || item.timeoutMs <= 0 || item.timeoutMs > MAX_TIMEOUT_MS) {
        add(`${at}.timeoutMs`, `must be a positive number up to ${MAX_TIMEOUT_MS}`)
        return
      }
      check.timeoutMs = Math.round(item.timeoutMs)
    }

    if (type === 'file') {
      if (!isNonEmptyString(item.path)) add(`${at}.path`, 'must be a non-empty string')
      if (item.minBytes !== undefined && (!Number.isInteger(item.minBytes) || item.minBytes < 0)) {
        add(`${at}.minBytes`, 'must be a non-negative integer')
      }
      check.path = String(item.path ?? '').trim()
      check.minBytes = Number.isInteger(item.minBytes) ? item.minBytes : 1
    }

    if (type === 'text') {
      const hasFile = isNonEmptyString(item.file)
      const hasScreen = item.screen === true
      if (!hasFile && !hasScreen) add(`${at}.file`, 'text needs "file" or screen:true')
      const hasAppear = isNonEmptyString(item.appear)
      const hasAbsent = isNonEmptyString(item.absent)
      if (hasAppear === hasAbsent) add(`${at}.appear`, 'exactly one of "appear" / "absent" is required')
      check.file = hasFile ? String(item.file).trim() : null
      check.screen = hasScreen
      check.appear = hasAppear ? String(item.appear) : null
      check.absent = hasAbsent ? String(item.absent) : null
      if (item.region !== undefined) check.region = String(item.region)
    }

    if (type === 'screen') {
      if (!isNonEmptyString(item.appear)) add(`${at}.appear`, 'must be a non-empty string')
      check.appear = String(item.appear ?? '')
      if (item.region !== undefined) check.region = String(item.region)
    }

    if (type === 'exit') {
      if (!isNonEmptyString(item.command, 300)) add(`${at}.command`, 'must be a non-empty string')
      const phrase = String(item.command ?? '').trim().split(/\s+/, 1)[0].toLowerCase()
      const bare = phrase.replace(/\.(exe|cmd|bat)$/, '')
      if (!COMMAND_ALLOWLIST.includes(bare)) {
        add(`${at}.command`, `command must start with one of: ${COMMAND_ALLOWLIST.join(', ')}`)
      }
      check.command = String(item.command ?? '').trim()
    }

    if (type === 'changed') {
      if (item.region !== undefined) check.region = String(item.region)
    }

    checks.push(check)
  })

  return { ok: errors.length === 0, errors, checks }
}

// ---------------------------------------------------------------- execution

function describeTarget(check) {
  if (check.type === 'file') return `文件 ${check.path}`
  if (check.type === 'exit') return `命令 ${check.command}`
  if (check.type === 'changed') return '画面变化'
  if (check.region) return `区域 ${check.region}`
  return check.file ? `文件 ${check.file}` : '屏幕'
}

function elapsed(started) {
  return Math.max(0, Date.now() - started)
}


/**
 * 判据路径的敏感目录黑名单。
 *
 * 为什么是黑名单而不是白名单：这是给普通人用的开源插件，开箱就得能用 ——
 * 白名单要求先配置一个根目录，配不明白就用不了，用户会直接把检查关掉。
 * 黑名单默认挡住"看一眼就知道会出事"的地方（系统目录、凭证目录、浏览器配置），
 * 让 `text` 判据没法当成"读你私钥"的 1 比特探针。
 *
 * 它只是减速带，不是沙箱：判据以用户权限运行，真要读什么还是读得到。
 */
const SENSITIVE = [
  /\\windows\\/i,
  /\\program files/i,
  /\\programdata\\/i,
  /\\\.ssh\\/i,
  /\\\.aws\\/i,
  /\\\.azure\\/i,
  /\\\.gnupg\\/i,
  /\\appdata\\local\\microsoft\\credentials/i,
  /\\appdata\\roaming\\microsoft\\crypto/i,
  /\\appdata\\local\\google\\chrome\\user data/i,
  /\\appdata\\local\\microsoft\\edge\\user data/i,
  /\\appdata\\roaming\\mozilla\\firefox/i,
]
const SENSITIVE_EXT = /\.(pem|key|pfx|p12|kdbx|ovpn|ppk|kwallet)$/i

/** 这个路径是否落在不该被验收判据碰的地方。 */
export function isSensitivePath(target) {
  const path = String(target ?? '')
  if (!path) return false
  const normalized = path.replace(/\//g, '\\')
  if (SENSITIVE_EXT.test(normalized)) return true
  return SENSITIVE.some((re) => re.test(normalized))
}

async function runOne(check, vars, deps) {
  const started = Date.now()
  const base = { type: check.type, target: '', ok: false, expected: '', actual: '', ms: 0 }

  // 1) Resolve every string field first; a missing variable fails the check.
  const fields = ['path', 'file', 'appear', 'absent', 'command', 'region']
  const resolved = { ...check }
  const missing = []
  for (const field of fields) {
    if (typeof check[field] !== 'string') continue
    const sub = substitute(check[field], vars)
    if (!sub.ok) missing.push(...sub.missing)
    resolved[field] = sub.value
  }
  base.target = describeTarget(resolved)
  if (missing.length > 0) {
    base.expected = `变量 ${missing.map((m) => `{{${m}}}`).join(', ')} 有值`
    base.actual = '没拿到值（调用方没传这个参数）'
    base.ms = elapsed(started)
    return base
  }

  // 2) Ask the dependency layer.
  try {
    if ((resolved.type === 'file' || resolved.type === 'text') && isSensitivePath(resolved.path || resolved.file)) {
      base.ok = false
      base.expected = '不是一个敏感的目录/文件'
      base.actual = '路径落在敏感目录（系统目录、凭证目录或密钥文件），拒绝用作验收判据'
      base.ms = elapsed(started)
      return base
    }
    if (resolved.type === 'file') {
      const exists = await deps.exists(resolved.path)
      const size = exists ? await deps.size(resolved.path) : 0
      base.expected = `存在且 ≥ ${resolved.minBytes} 字节`
      base.actual = exists ? `${size} 字节` : '文件不存在'
      base.ok = exists && size >= resolved.minBytes
    } else if (resolved.type === 'text') {
      const want = resolved.appear !== null && resolved.appear !== undefined ? resolved.appear : resolved.absent
      const needAppear = resolved.appear !== null && resolved.appear !== undefined
      base.expected = needAppear ? `包含「${want}」` : `不包含「${want}」`
      let haystack = ''
      if (resolved.file) {
        const exists = await deps.exists(resolved.file)
        if (!exists) {
          base.actual = '文件不存在'
          base.ms = elapsed(started)
          return base
        }
        haystack = await deps.readText(resolved.file)
      } else {
        // Screen source: reuse the same text finder as the eye layer.
        const hay = await deps.screenText(resolved.region)
        haystack = hay || ''
      }
      const found = haystack.includes(want)
      base.ok = needAppear ? found : !found
      base.actual = found ? '找到了' : '没找到'
    } else if (resolved.type === 'screen') {
      base.expected = `屏幕上出现「${resolved.appear}」`
      const found = await deps.findOnScreen(resolved.appear, resolved.region)
      base.ok = Boolean(found)
      base.actual = found ? '出现了' : '没出现'
    } else if (resolved.type === 'exit') {
      base.expected = '退出码 0'
      const result = await deps.runCommand(resolved.command, resolved.timeoutMs)
      base.ok = result.code === 0
      base.actual = `退出码 ${result.code}${result.stderr ? `（${String(result.stderr).slice(0, 120)}）` : ''}`
    } else if (resolved.type === 'changed') {
      base.expected = '与上一次观察相比画面有变化'
      const changed = await deps.screenChanged(resolved.region)
      base.ok = Boolean(changed)
      base.actual = changed ? '有变化' : '没有变化'
    }
  } catch (error) {
    base.ok = false
    base.actual = `检查时出错：${error instanceof Error ? error.message : String(error)}`
  }

  base.ms = elapsed(started)
  return base
}

/**
 * Run every check against the world. All checks must pass; the function itself
 * never throws (a broken dependency becomes a failed check with the reason).
 * @param {object[]} checks normalised checks
 * @param {object} vars template variables
 * @param {{exists:Function,size:Function,readText:Function,screenText:Function,findOnScreen:Function,runCommand:Function,screenChanged:Function}} deps
 */
export async function runChecks(checks, vars = {}, deps = {}) {
  const results = []
  for (const check of Array.isArray(checks) ? checks : []) {
    // eslint-disable-next-line no-await-in-loop -- checks are ordered and few; serial keeps output readable
    results.push(await runOne(check, vars, deps))
  }
  return { ok: results.every((r) => r.ok), checks: results }
}

// ---------------------------------------------------------------- reporting

/**
 * Render a result for the model. The whole point is expected-vs-actual per
 * check: "verification failed" alone gives the model nothing to work with.
 */
export function formatChecks(result) {
  if (!result || !Array.isArray(result.checks)) return '（没有验收结果）'
  const total = result.checks.length
  const passed = result.checks.filter((c) => c.ok).length
  const head = result.ok
    ? `验收通过（${passed}/${total}）`
    : `验收没过（${passed}/${total} 通过）`
  const lines = [head]
  for (const check of result.checks) {
    const mark = check.ok ? '通过' : '失败'
    lines.push(`  [${mark}] ${check.target}：期望 ${check.expected}；实际 ${check.actual}`)
  }
  return lines.join('\n')
}

/** How many checks failed, used for the "two strikes" rule later. */
export function countFailures(result) {
  if (!result || !Array.isArray(result.checks)) return 0
  return result.checks.filter((c) => !c.ok).length
}
