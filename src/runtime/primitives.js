// Real primitives behind the capability ops: handeye for input/observation,
// the CDP browser for page text, UIA launch for opening URLs.

import { runHandeye, codeMeaning } from '../handeye.js'
import { openUrl, pageText } from '../browser.js'
import { launchApp } from '../desk.js'

function wrap(result) {
  const ok = result?.ok === true
  const stderr = String(result?.stderr ?? '').trim()
  return {
    ok,
    code: result?.code ?? 0,
    message: ok ? '' : stderr || codeMeaning(result?.code ?? 3) || 'handeye failed',
    stdout: result?.stdout ?? '',
  }
}

export function createPrimitives({
  run = runHandeye,
  openUrl: openUrlImpl = openUrl,
  pageText: pageTextImpl = pageText,
  launch = launchApp,
  timeoutMs = 60000,
} = {}) {
  return {
    async launch(target) {
      try {
        await launch(String(target))
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async focusWindow(title) {
      return wrap(await run(['focus', String(title)], { timeoutMs }))
    },

    async clickText(text, { expect } = {}) {
      const args = ['click-text', String(text)]
      if (expect) args.push('--expect', String(expect))
      return wrap(await run(args, { timeoutMs }))
    },

    async typeText(text) {
      return wrap(await run(['type', String(text)], { timeoutMs }))
    },

    async pressKey(key) {
      return wrap(await run(['key', String(key)], { timeoutMs }))
    },

    async seeJson() {
      const result = await run(['see', '--json', '--best', '--scale', '2'], { timeoutMs })
      if (!result?.ok) {
        return { ok: false, error: wrap(result).message }
      }
      try {
        return JSON.parse(result.stdout)
      } catch {
        return { ok: false, error: 'Invalid JSON from handeye see' }
      }
    },

    async screenshot(path) {
      return wrap(await run(['see', '--save', String(path), '--scale', '1'], { timeoutMs }))
    },

    async browserOpen(url) {
      try {
        const opened = await openUrlImpl(String(url))
        return { ok: true, tabId: opened.tabId, brief: opened.url }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async browserText() {
      try {
        const page = await pageTextImpl(undefined, 6000)
        return { ok: true, text: page.text, title: page.title }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
