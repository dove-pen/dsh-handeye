import test from 'node:test'
import assert from 'node:assert/strict'

import {
  substitute,
  normalizeChecks,
  runChecks,
  formatChecks,
  countFailures,
  COMMAND_ALLOWLIST,
  VERIFY_TYPES,
} from '../../src/core/verify.js'

// ---------------------------------------------------------------- substitute

test('substitute replaces simple and dotted variables', () => {
  const vars = { path: 'D:\\out.md', goal: { title: '做个助手' } }
  assert.deepEqual(substitute('{{path}}', vars), { ok: true, value: 'D:\\out.md', missing: [] })
  assert.equal(substitute('关于 {{goal.title}} 的文档', vars).value, '关于 做个助手 的文档')
  assert.equal(substitute('{{  path  }}', vars).value, 'D:\\out.md')
})

test('substitute reports missing variables instead of blanking them', () => {
  const result = substitute('{{path}}/{{nope}}', { path: 'x' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['nope'])
  assert.equal(result.value, 'x/{{nope}}') // 原样保留，方便人看出来少什么
})

test('substitute tolerates non-string input', () => {
  assert.equal(substitute(null).value, '')
  assert.equal(substitute(undefined, {}).ok, true)
})

// ---------------------------------------------------------------- normalizeChecks

test('normalizeChecks accepts the five documented types', () => {
  const raw = [
    { type: 'file', path: 'D:\\a.md', minBytes: 10 },
    { type: 'text', file: 'D:\\a.md', appear: '来源' },
    { type: 'screen', appear: '保存成功' },
    { type: 'exit', command: 'node --test' },
    { type: 'changed' },
  ]
  const result = normalizeChecks(raw)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.checks.length, 5)
  assert.equal(result.checks[0].minBytes, 10)
  assert.equal(VERIFY_TYPES.length, 5)
})

test('normalizeChecks defaults minBytes to 1 and does not mutate the input', () => {
  const raw = [{ type: 'file', path: 'x' }]
  const result = normalizeChecks(raw)
  assert.equal(result.checks[0].minBytes, 1)
  assert.equal(raw[0].minBytes, undefined)
})

test('normalizeChecks rejects a bad shape with a path pointer', () => {
  const cases = [
    [[], '1-8'],
    ['nope', 'array'],
    [[{ type: 'nope' }], 'type'],
    [[{ type: 'text', appear: 'x' }], 'file'],
    [[{ type: 'text', file: 'x' }], 'appear'],
    [[{ type: 'text', file: 'x', appear: 'a', absent: 'b' }], 'appear'],
    [[{ type: 'file' }], 'path'],
    [[{ type: 'file', path: 'x', minBytes: -1 }], 'minBytes'],
    [[{ type: 'exit' }], 'command'],
    [[{ type: 'exit', command: 'rm -rf /' }], 'command'],
    [[{ type: 'changed', timeoutMs: 999999 }], 'timeoutMs'],
  ]
  for (const [raw, hint] of cases) {
    const result = normalizeChecks(raw)
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(raw)}`)
    assert.ok(result.errors.length > 0)
    const text = JSON.stringify(result.errors)
    assert.ok(text.includes(hint), `expected hint ${hint} in ${text}`)
  }
})

test('normalizeChecks refuses commands outside the allowlist', () => {
  for (const command of ['node --test', 'npm run build', 'git status', 'dir C:\\']) {
    assert.equal(normalizeChecks([{ type: 'exit', command }]).ok, true, command)
  }
  for (const command of ['powershell -c rm', 'curl http://x', 'del C:\\x']) {
    assert.equal(normalizeChecks([{ type: 'exit', command }]).ok, false, command)
  }
  assert.ok(COMMAND_ALLOWLIST.includes('node'))
})

// ---------------------------------------------------------------- runChecks

function fakeDeps(overrides = {}) {
  return {
    exists: async () => true,
    size: async () => 500,
    readText: async () => '正文里有 来源：https://example.com',
    screenText: async () => '屏幕上有 保存成功',
    findOnScreen: async () => true,
    runCommand: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    screenChanged: async () => true,
    ...overrides,
  }
}

test('runChecks passes when every check passes', async () => {
  const checks = normalizeChecks([
    { type: 'file', path: '{{path}}', minBytes: 10 },
    { type: 'text', file: '{{path}}', appear: '来源' },
    { type: 'exit', command: 'node --test' },
  ]).checks
  const result = await runChecks(checks, { path: 'D:\\a.md' }, fakeDeps())
  assert.equal(result.ok, true)
  assert.equal(result.checks.length, 3)
})

test('runChecks fails the whole run when one check fails', async () => {
  const checks = normalizeChecks([
    { type: 'file', path: '{{path}}' },
    { type: 'exit', command: 'node --test' },
  ]).checks
  const result = await runChecks(checks, { path: 'D:\\a.md' }, fakeDeps({ runCommand: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }))
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].ok, true)
  assert.equal(result.checks[1].ok, false)
  assert.match(result.checks[1].actual, /退出码 1/)
  assert.match(result.checks[1].actual, /boom/)
})

test('runChecks treats a missing file as a failure, not a throw', async () => {
  const checks = normalizeChecks([{ type: 'file', path: '{{path}}' }]).checks
  const result = await runChecks(checks, { path: 'D:\\nope.md' }, fakeDeps({ exists: async () => false }))
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].actual, '文件不存在')
})

test('runChecks fails when a template variable has no value', async () => {
  const checks = normalizeChecks([{ type: 'file', path: '{{path}}' }]).checks
  const result = await runChecks(checks, {}, fakeDeps())
  assert.equal(result.ok, false)
  assert.match(result.checks[0].expected, /变量 \{\{path\}\}/)
  assert.match(result.checks[0].actual, /没拿到值/)
})

test('runChecks supports absent and screen sources', async () => {
  const absent = normalizeChecks([{ type: 'text', file: '{{path}}', absent: '错误' }]).checks
  const okAbsent = await runChecks(absent, { path: 'x' }, fakeDeps())
  assert.equal(okAbsent.ok, true)

  const onScreen = normalizeChecks([{ type: 'screen', appear: '保存成功' }]).checks
  const okScreen = await runChecks(onScreen, {}, fakeDeps())
  assert.equal(okScreen.ok, true)

  const missing = await runChecks(onScreen, {}, fakeDeps({ findOnScreen: async () => false }))
  assert.equal(missing.ok, false)
  assert.equal(missing.checks[0].actual, '没出现')
})

test('runChecks turns a throwing dependency into a readable failure', async () => {
  const checks = normalizeChecks([{ type: 'changed' }]).checks
  const result = await runChecks(checks, {}, fakeDeps({ screenChanged: async () => { throw new Error('没有屏幕') } }))
  assert.equal(result.ok, false)
  assert.match(result.checks[0].actual, /检查时出错：没有屏幕/)
})

test('runChecks on an empty list is vacuously ok', async () => {
  const result = await runChecks([], {}, fakeDeps())
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks, [])
})

// ---------------------------------------------------------------- reporting

test('formatChecks always shows expected vs actual per check', () => {
  const text = formatChecks({
    ok: false,
    checks: [
      { type: 'file', target: '文件 D:\\a.md', ok: false, expected: '存在且 ≥ 100 字节', actual: '文件不存在' },
      { type: 'text', target: '文件 D:\\a.md', ok: true, expected: '包含「来源」', actual: '找到了' },
    ],
  })
  assert.match(text, /验收没过（1\/2 通过）/)
  assert.match(text, /\[失败\] 文件 D:\\a\.md：期望 存在且 ≥ 100 字节；实际 文件不存在/)
  assert.match(text, /\[通过\]/)
  assert.equal(formatChecks(null), '（没有验收结果）')
})

test('countFailures counts the failed checks', () => {
  assert.equal(countFailures({ checks: [{ ok: true }, { ok: false }, { ok: false }] }), 2)
  assert.equal(countFailures(null), 0)
  assert.equal(countFailures({ checks: [] }), 0)
})
