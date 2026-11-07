// Real primitives behind the capability ops: handeye for input/observation,
// the CDP browser for page text, UIA launch for opening URLs.

import { execFile } from 'node:child_process'
import { runHandeye, codeMeaning } from '../handeye.js'
import { openUrl, pageText } from '../browser.js'
import { launchApp, listWindows } from '../desk.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isWebTarget(target) {
  return /^https?:\/\//i.test(String(target))
}

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
        if (!isWebTarget(target)) return { ok: true }

        // A URL opens in a browser window, but it may stay behind the current
        // window. Find it and focus it so later read/wait steps see the page.
        const host = (() => {
          try {
            return new URL(String(target)).hostname.replace(/^www\./i, '')
          } catch {
            return ''
          }
        })()
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          try {
            const windows = await listWindows()
            const hit = windows.find((w) => {
              const title = String(w.title || '')
              return /chrome|edge|firefox|brave|opera/i.test(title) || (host && title.toLowerCase().includes(host))
            })
            if (hit) {
              const focused = await run(['focus', String(hit.title || 'Chrome')], { timeoutMs: 8000 })
              if (focused.ok) return { ok: true }
            }
          } catch {
            // window enumeration is best effort
          }
          await sleep(400)
        }
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

    systemInfo(scope = 'brief') {
      const full = scope === 'full'
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$os = Get-CimInstance Win32_OperatingSystem',
        '$cs = Get-CimInstance Win32_ComputerSystem',
        '"time=" + (Get-Date -Format s)',
        '"os=" + $os.Caption',
        '"uptime_hours=" + [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)',
        '"mem_total_gb=" + [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)',
        '"mem_free_gb=" + [math]::Round($os.FreePhysicalMemory / 1MB, 1)',
        '"cpu_logical=" + $cs.NumberOfLogicalProcessors',
        'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "disk_" + $_.Name + "_free_gb=" + [math]::Round($_.Free / 1GB, 1) + " used_gb=" + [math]::Round($_.Used / 1GB, 1) }',
        ...(full
          ? [
              '"top_processes="',
              'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 3 | ForEach-Object { "proc " + $_.ProcessName + " mem_mb=" + [math]::Round($_.WorkingSet64 / 1MB) }',
              '"recent_errors_24h=" + (Get-WinEvent -FilterHashtable @{LogName="Application"; Level=1,2; StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Measure-Object).Count',
            ]
          : []),
      ].join('; ')
      return new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (error) resolve({ ok: false, message: String(stderr || error.message).trim() })
            else resolve({ ok: true, text: String(stdout || '').trim() })
          },
        )
      })
    },
  }
}
