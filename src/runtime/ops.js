// Op implementations for capability steps.
//
// Every primitive is injected, so the mapping from a declarative step to a real
// side effect stays visible in one place and tests can drive it without a screen.
//
// Browser mode: `open_url` either hands the URL to the system browser (default,
// keeps the user's login) or to the dedicated CDP browser (channel="browser").
// Later read/wait/assert steps read from the same source.

import os from 'node:os'
import path from 'node:path'

const DEFAULT_WAIT_MS = 15000
const POLL_MS = 300

function brief(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function joinViewText(view) {
  const blocks = view?.blocks ?? []
  return blocks
    .map((block) => (block.items ?? []).map((item) => item.text).join(' '))
    .join('\n')
    .trim()
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export function createOps({ primitives, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now() } = {}) {
  if (!primitives) throw new TypeError('createOps requires primitives')

  async function sourceText(ctx) {
    if (ctx.browserMode === 'browser') {
      const result = await primitives.browserText()
      if (!result || result.ok !== true) return { ok: false, message: result?.message || 'browser text failed' }
      return { ok: true, text: String(result.text ?? result.brief ?? '') }
    }
    const view = await primitives.seeJson()
    if (!view) return { ok: false, message: 'screen read failed' }
    if (view.ok === false) return { ok: false, message: view.error || 'screen read failed' }
    return { ok: true, text: joinViewText(view) }
  }

  async function waitForText(text, timeoutMs, ctx) {
    const deadline = clock() + timeoutMs
    let last = ''
    for (;;) {
      const read = await sourceText(ctx)
      if (read.ok) {
        last = read.text
        if (read.text.includes(text)) return { ok: true, brief: `found: ${brief(text, 80)}` }
      }
      if (clock() >= deadline) {
        return { ok: false, message: `text not found within ${timeoutMs}ms: ${brief(text, 80)}`, actual: brief(last, 200) }
      }
      await sleep(POLL_MS)
    }
  }

  async function run(step, ctx = {}) {
    const started = clock()
    const vars = ctx.vars ?? {}
    const timeoutMs = Number.isFinite(step.timeoutMs) ? step.timeoutMs : DEFAULT_WAIT_MS
    ctx.vars = vars

    let result
    switch (step.op) {
      case 'open_url': {
        if (step.channel === 'browser') {
          const opened = await primitives.browserOpen(step.url)
          ctx.browserMode = 'browser'
          // The CDP page needs a moment before its body text exists.
          const deadline = clock() + 8000
          while (clock() < deadline) {
            const page = await primitives.browserText()
            if (page?.ok && String(page.text ?? '').trim()) break
            await sleep(250)
          }
          result = { ok: opened?.ok !== false, message: opened?.message, brief: brief(step.url) }
        } else {
          const launched = await primitives.launch(step.url)
          ctx.browserMode = 'system'
          result = { ok: launched?.ok !== false, message: launched?.message, brief: brief(step.url) }
        }
        break
      }
      case 'focus_window': {
        const focused = await primitives.focusWindow(step.title)
        result = { ok: focused?.ok !== false, message: focused?.message, brief: brief(step.title) }
        break
      }
      case 'wait_text': {
        result = await waitForText(String(step.text ?? ''), timeoutMs, ctx)
        break
      }
      case 'click_text': {
        const clicked = await primitives.clickText(String(step.text ?? ''), { expect: step.expect })
        result = { ok: clicked?.ok !== false, message: clicked?.message, brief: brief(step.text), screenshot: clicked?.screenshot }
        break
      }
      case 'type_text': {
        const typed = await primitives.typeText(String(step.text ?? ''))
        result = { ok: typed?.ok !== false, message: typed?.message, brief: brief(`typed ${String(step.text ?? '').length} chars`) }
        break
      }
      case 'press_key': {
        const pressed = await primitives.pressKey(String(step.key ?? ''))
        result = { ok: pressed?.ok !== false, message: pressed?.message, brief: brief(step.key) }
        break
      }
      case 'read_text': {
        const read = await sourceText(ctx)
        if (!read.ok) {
          result = { ok: false, message: read.message }
          break
        }
        if (!String(read.text ?? '').trim() && !step.pattern) {
          result = { ok: false, message: 'no text could be read from the current source' }
          break
        }
        if (step.pattern) {
          const re = safeRegex(step.pattern)
          if (!re) {
            result = { ok: false, message: `invalid pattern: ${step.pattern}` }
            break
          }
          const match = read.text.match(re)
          if (!match) {
            result = { ok: false, message: `pattern not found: ${step.pattern}`, actual: brief(read.text, 200) }
            break
          }
          const value = match[1] ?? match[0]
          if (step.as) vars[step.as] = value
          result = { ok: true, brief: brief(value) }
        } else {
          if (step.as) vars[step.as] = read.text
          result = { ok: true, brief: brief(read.text) }
        }
        break
      }
      case 'assert_text': {
        const read = await sourceText(ctx)
        if (!read.ok) {
          result = { ok: false, message: read.message }
          break
        }
        const expected = String(step.text ?? '')
        result = read.text.includes(expected)
          ? { ok: true, brief: `found: ${brief(expected, 80)}` }
          : { ok: false, message: `expected text not found: ${brief(expected, 80)}`, actual: brief(read.text, 200) }
        break
      }
      case 'screenshot': {
        const target = step.path || path.join(os.tmpdir(), `dsh-handeye-plus-${Date.now()}.png`)
        const shot = await primitives.screenshot(target)
        result = { ok: shot?.ok !== false, message: shot?.message, brief: target }
        break
      }
      case 'system_info': {
        const info = await primitives.systemInfo(step.scope === 'full' ? 'full' : 'brief')
        if (!info?.ok) {
          result = { ok: false, message: info?.message || 'system info failed' }
          break
        }
        const key = step.as || 'text'
        vars[key] = info.text
        result = { ok: true, brief: brief(info.text, 200) }
        break
      }
      case 'scroll_to_text': {
        result = { ok: false, message: 'scroll_to_text is not supported yet' }
        break
      }
      default: {
        result = { ok: false, message: `unsupported op: ${step.op}` }
      }
    }

    if (!result || typeof result !== 'object') result = { ok: false, message: 'op returned no result' }
    if (result.ok && result.vars) Object.assign(vars, result.vars)
    if (result.ms === undefined) result.ms = clock() - started
    return result
  }

  async function checkPrecondition(pre) {
    if (!pre || typeof pre.check !== 'string') return { ok: false, message: 'invalid precondition' }
    switch (pre.check) {
      case 'text_present': {
        const ctx = { browserMode: pre.channel === 'browser' ? 'browser' : null }
        const read = await sourceText(ctx)
        if (!read.ok) return { ok: false, message: read.message }
        return read.text.includes(String(pre.text ?? ''))
          ? { ok: true }
          : { ok: false, message: `expected text not present: ${brief(pre.text, 80)}` }
      }
      case 'app': {
        const focused = await primitives.focusWindow(pre.title ?? pre.exe ?? '')
        return focused?.ok === false
          ? { ok: false, message: focused.message || 'application not found' }
          : { ok: true }
      }
      default:
        return { ok: false, message: `unsupported precondition: ${pre.check}` }
    }
  }

  async function checkPostcondition(post, vars) {
    if (!post || typeof post.assert !== 'string') return { ok: false, message: 'invalid postcondition' }
    switch (post.assert) {
      case 'isset':
        return Object.prototype.hasOwnProperty.call(vars, post.var)
          ? { ok: true }
          : { ok: false, message: `variable not set: ${post.var}` }
      default:
        return { ok: false, message: `unsupported assertion: ${post.assert}` }
    }
  }

  return { run, checkPrecondition, checkPostcondition }
}
