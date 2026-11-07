// Tool classification and risk model. Pure functions only.

export const META_TOOLS = new Set([
  'episode_begin',
  'episode_query',
  'episode_replan',
  'episode_checkpoint',
  'pause_request',
])

const READ_TOOLS = new Set([
  'desk_windows',
  'desk_tree',
  'desk_find',
  'desk_text',
  'browser_tabs',
  'browser_snapshot',
  'browser_text',
  'hand_where',
  'yl_log',
])

const WRITE_TOOLS = new Set([
  'hand_click',
  'hand_click_text',
  'hand_type',
  'hand_key',
  'hand_focus',
  'desk_invoke',
  'desk_set_value',
  'desk_focus',
  'desk_launch',
  'desk_batch',
  'browser_open',
  'browser_attach',
  'browser_click',
  'browser_fill',
  'browser_navigate',
  'browser_close',
  'browser_stop',
])

// Conservative patterns: a false positive only costs one confirmation.
const DESTRUCTIVE_RE = /删除|格式化|清空|卸载|注销|关机|重启|\bshutdown\b|\bformat\b|\bdel\s|\brm\s+-rf/i

export function isMetaTool(tool) {
  return META_TOOLS.has(String(tool))
}

export function isReadTool(tool, args = {}) {
  const name = String(tool)
  if (name.startsWith('eye_')) return true
  if (READ_TOOLS.has(name)) return true
  if (name === 'capability') return args?.action === 'list' || args?.action === 'show'
  return false
}

export function isActionTool(tool, args = {}) {
  const name = String(tool)
  if (isMetaTool(name)) return false
  if (isReadTool(name, args)) return false
  if (name === 'capability') return args?.action === 'run'
  if (WRITE_TOOLS.has(name)) return true
  // Unknown tools are treated as actions: better to ask once than to miss one.
  return true
}

export function classifyRisk(tool, args = {}) {
  const explicit = args?.risk
  if (explicit === 'read' || explicit === 'write' || explicit === 'destructive') return explicit
  if (isReadTool(tool, args)) return 'read'
  let text = ''
  try {
    text = JSON.stringify(args ?? {})
  } catch {
    text = String(args)
  }
  return DESTRUCTIVE_RE.test(text) ? 'destructive' : 'write'
}

export function matchTool(pattern, tool) {
  const p = String(pattern ?? '')
  if (!p) return false
  if (p.endsWith('*')) return String(tool).startsWith(p.slice(0, -1))
  return p === String(tool)
}

export function matchAny(patterns, tool) {
  return Array.isArray(patterns) && patterns.some((p) => matchTool(p, tool))
}
