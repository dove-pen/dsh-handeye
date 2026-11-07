import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseDevToolsActivePort,
  parseRemoteDebuggingPorts,
  normalisePorts,
  browserPort,
  browserMode,
  isAttached,
  detachBrowser,
  COMMON_PORTS,
} from '../../src/browser.js'

test('parseDevToolsActivePort reads the first line only', () => {
  assert.equal(parseDevToolsActivePort('9222\n/devtools/browser/abc'), 9222)
  assert.equal(parseDevToolsActivePort('  9333  '), 9333)
  assert.equal(parseDevToolsActivePort('0'), null)
  assert.equal(parseDevToolsActivePort(''), null)
  assert.equal(parseDevToolsActivePort('not-a-port'), null)
  assert.equal(parseDevToolsActivePort('99999'), null)
  assert.equal(parseDevToolsActivePort(null), null)
})

test('parseRemoteDebuggingPorts handles both --flag=N and --flag N', () => {
  const lines = [
    '"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=x',
    'chrome.exe --remote-debugging-port 9223 --profile-directory=Default',
    'chrome.exe --no-first-run',
    'msedge.exe --remote-debugging-pipe',
  ]
  assert.deepEqual(parseRemoteDebuggingPorts(lines), [9222, 9223])
  assert.deepEqual(parseRemoteDebuggingPorts([]), [])
  assert.deepEqual(parseRemoteDebuggingPorts(null), [])
})

test('parseRemoteDebuggingPorts ignores out-of-range values', () => {
  assert.deepEqual(parseRemoteDebuggingPorts(['--remote-debugging-port=0']), [])
  assert.deepEqual(parseRemoteDebuggingPorts(['--remote-debugging-port=99999']), [])
})

test('normalisePorts de-duplicates and keeps order', () => {
  assert.deepEqual(normalisePorts([9333, '9222', 9333, 0, -1, 'x', 9222]), [9333, 9222])
  assert.deepEqual(normalisePorts([]), [])
  assert.deepEqual(normalisePorts(null), [])
})

test('the module starts in own-browser mode on the default port', () => {
  assert.equal(browserMode(), 'own')
  assert.equal(isAttached(), false)
  assert.ok(COMMON_PORTS.includes(9333))
  assert.equal(typeof browserPort(), 'number')
})

test('detachBrowser returns to own mode and forgets the attached port', () => {
  const r = detachBrowser()
  assert.equal(browserMode(), 'own')
  assert.equal(isAttached(), false)
  assert.equal(typeof r.port, 'number')
})
