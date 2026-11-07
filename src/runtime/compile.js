// Compile a successful episode into a capability draft.
//
// Only semantic steps survive: coordinates and element indices are rejected
// with a warning, observations are dropped. The draft is never enabled here —
// a human reviews it in the panel first.

import { validateCapability } from '../memory/schema.js'

const DESTRUCTIVE_RE = /删除|格式化|清空|卸载|注销|关机|重启|\bshutdown\b|\bformat\b|\bdel\s|\brm\s+-rf/i

const WRITE_OPS = new Set(['click_text', 'type_text', 'press_key'])

const OBSERVATION_TOOLS = new Set([
  'eye_see',
  'eye_find',
  'eye_changed',
  'eye_shot',
  'eye_text',
  'desk_windows',
  'desk_tree',
  'desk_find',
  'desk_text',
  'browser_snapshot',
  'browser_text',
  'browser_tabs',
  'yl_log',
])

function isUrl(text) {
  return /^https?:\/\//i.test(String(text ?? ''))
}

function stepFor(tool, args = {}) {
  switch (tool) {
    case 'hand_focus':
      return args.title ? { op: 'focus_window', title: String(args.title) } : null
    case 'hand_click_text':
      if (!args.text) return null
      return args.expect
        ? { op: 'click_text', text: String(args.text), expect: String(args.expect) }
        : { op: 'click_text', text: String(args.text) }
    case 'hand_type':
      return { op: 'type_text', text: String(args.text ?? '') }
    case 'hand_key':
      return args.key ? { op: 'press_key', key: String(args.key) } : null
    case 'browser_open':
    case 'browser_navigate':
      return args.url ? { op: 'open_url', url: String(args.url), channel: 'browser' } : null
    case 'desk_launch':
      return isUrl(args.target) ? { op: 'open_url', url: String(args.target) } : null
    default:
      return null
  }
}

function riskOf(steps, rawText) {
  if (DESTRUCTIVE_RE.test(rawText)) return 'destructive'
  if (steps.some((step) => WRITE_OPS.has(step.op))) return 'write'
  return 'read'
}

/**
 * @param {object} episode recorded episode
 * @param {{name:string, title:string, description?:string, risk?:string}} meta
 * @returns {{ok:true, capability:object, warnings:string[]} | {ok:false, message:string, warnings:string[]}}
 */
export function compileEpisode(episode, meta) {
  const warnings = []
  if (!episode || typeof episode !== 'object' || !Array.isArray(episode.steps)) {
    return { ok: false, message: 'Episode has no steps', warnings }
  }

  const steps = []
  episode.steps.forEach((step, index) => {
    if (!step || step.ok === false) return
    const tool = String(step.tool ?? '')
    if (OBSERVATION_TOOLS.has(tool)) return

    if (tool === 'hand_click') {
      warnings.push(`Step ${index + 1} (hand_click): coordinate clicks cannot be replayed; skipped`)
      return
    }
    if (tool === 'browser_click' || tool === 'browser_fill') {
      warnings.push(`Step ${index + 1} (${tool}): element index is not stable across runs; skipped`)
      return
    }
    if (tool === 'desk_batch') {
      warnings.push(`Step ${index + 1} (desk_batch): batch actions are not supported in capabilities; skipped`)
      return
    }
    if (tool === 'capability') {
      warnings.push(`Step ${index + 1} (capability): nested capabilities cannot be compiled; skipped`)
      return
    }
    if (tool === 'hand_click_text' && !step.args?.text) {
      warnings.push(`Step ${index + 1} (hand_click_text): missing text; skipped`)
      return
    }

    const compiled = stepFor(tool, step.args)
    if (compiled) {
      steps.push(compiled)
      return
    }
    if (tool.startsWith('desk_') || tool.startsWith('browser_') || tool.startsWith('hand_')) {
      warnings.push(`Step ${index + 1} (${tool}): not compilable; skipped`)
    }
  })

  if (steps.length === 0) {
    return { ok: false, message: 'No replayable steps in this episode', warnings }
  }

  let rawText = ''
  try {
    rawText = JSON.stringify(episode.steps.map((s) => s.args ?? {}))
  } catch {
    rawText = ''
  }

  const capability = {
    schemaVersion: 1,
    name: String(meta.name),
    title: String(meta.title),
    description: String(meta.description ?? ''),
    risk: meta.risk || riskOf(steps, rawText),
    status: 'draft',
    params: {},
    preconditions: [],
    steps,
    postconditions: [],
    outputs: [],
    fromEpisode: String(episode.id ?? ''),
  }

  const check = validateCapability(capability)
  if (!check.ok) return { ok: false, message: 'Compiled capability is invalid', warnings, errors: check.errors }

  warnings.push('Step values are hard-coded; edit the draft to add parameters before enabling it.')
  return { ok: true, capability, warnings }
}
