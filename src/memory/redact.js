// Secret redaction.
//
// Applied at the write boundary (episode files, log views, card imports) and
// before anything leaves the plugin toward the UI. Never rely on a downstream
// consumer to mask secrets.

const RULES = [
  // GitHub tokens
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_REDACTED'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_REDACTED'],
  // Generic API keys
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-REDACTED'],
  // Authorization headers
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1REDACTED'],
  // key=value pairs that commonly carry credentials
  [/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1REDACTED'],
  // Mainland China mobile numbers
  [/\b1[3-9]\d{9}\b/g, '1**********'],
  // Mainland China ID numbers
  [/\b\d{17}[\dXx]\b/g, '******************'],
]

const MAX_DEPTH = 8

export function redactText(input) {
  if (typeof input !== 'string' || input === '') return input
  let out = input
  for (const [re, replacement] of RULES) out = out.replace(re, replacement)
  return out
}

export function containsSecret(input) {
  if (typeof input !== 'string' || input === '') return false
  return RULES.some(([re]) => {
    re.lastIndex = 0
    return re.test(input)
  })
}

/** Deep-clone a JSON-like value with every string redacted. */
export function redactDeep(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[DepthLimit]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen, depth + 1))

  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, seen, depth + 1)
  return out
}
