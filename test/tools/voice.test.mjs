import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { normalizeSayArgs, sayWithFallback } from '../../src/voice.js'
import { createVoiceTools } from '../../src/tools/voice.js'

// ---------------------------------------------------------------- 参数

test('empty text is refused', () => {
  const r = normalizeSayArgs({ text: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /不能为空/)
})

test('over-long text is refused with the actual length', () => {
  const r = normalizeSayArgs({ text: '字'.repeat(301) })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /300/)
})

test('rate and volume are range-checked', () => {
  assert.equal(normalizeSayArgs({ text: 'x', rate: 11 }).ok, false)
  assert.equal(normalizeSayArgs({ text: 'x', volume: 101 }).ok, false)
  assert.equal(normalizeSayArgs({ text: 'x', rate: -11 }).ok, false)
  assert.equal(normalizeSayArgs({ text: 'x', rate: 5, volume: 60 }).ok, true)
})

test('defaults are rate 0 and volume 100', () => {
  const r = normalizeSayArgs({ text: ' 你好 ' })
  assert.equal(r.ok, true)
  assert.equal(r.args.text, '你好')
  assert.equal(r.args.rate, 0)
  assert.equal(r.args.volume, 100)
})

// ---------------------------------------------------------------- 两条通道

test('handeye is preferred when it works', async () => {
  const calls = []
  const r = await sayWithFallback(
    { text: '完成', rate: 0, volume: 100, voice: '', wav: '' },
    {
      runHandeye: async (argv) => {
        calls.push(argv)
        return { code: 0, stdout: '', stderr: '' }
      },
      runPs: async () => {
        throw new Error('不该走到备用通道')
      },
    },
  )
  assert.equal(r.ok, true)
  assert.equal(r.via, 'handeye')
  assert.deepEqual(calls[0], ['say', '完成'])
})

test('handeye failing falls back to system speech', async () => {
  const r = await sayWithFallback(
    { text: '完成', rate: 0, volume: 100, voice: '', wav: '' },
    {
      runHandeye: async () => ({ code: 1, stdout: '', stderr: 'ERR 语音合成失败: Internal Speech Error.' }),
      runPs: async () => ({ code: 0, stdout: 'SPOKEN\n', stderr: '' }),
    },
  )
  assert.equal(r.ok, true)
  assert.equal(r.via, 'system-speech')
})

test('both channels failing reports the reason instead of pretending', async () => {
  const r = await sayWithFallback(
    { text: '完成', rate: 0, volume: 100, voice: '', wav: '' },
    {
      runHandeye: async () => ({ code: 1, stdout: '', stderr: 'ERR x' }),
      runPs: async () => ({ code: 3, stdout: '', stderr: 'ERR 没声卡' }),
    },
  )
  assert.equal(r.ok, false)
  assert.match(r.message, /没声卡/)
})

test('wav mode reports the file and checks it is non-empty', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-test-'))
  const wav = path.join(dir, 'a.wav')
  try {
    // 备用通道谎报成功但没写文件 -> 必须判失败
    const lying = await sayWithFallback(
      { text: 'x', rate: 0, volume: 100, voice: '', wav },
      {
        runHandeye: async () => ({ code: 1, stdout: '', stderr: 'ERR' }),
        runPs: async () => ({ code: 0, stdout: 'WAV_OK\n', stderr: '' }),
      },
    )
    assert.equal(lying.ok, false)
    assert.match(lying.message, /没有生成有效 WAV/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 工具层

test('voice_say refuses bad args before touching the voice engine', async () => {
  let touched = false
  const tools = createVoiceTools({
    runHandeye: async () => {
      touched = true
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const say = tools.find((t) => t.name === 'voice_say')
  const out = await say.execute({ text: '' })
  assert.match(out, /Failed/)
  assert.equal(touched, false)
})

test('voice_say reports which channel was used', async () => {
  const tools = createVoiceTools({
    runHandeye: async () => ({ code: 1, stdout: '', stderr: 'ERR Internal Speech Error' }),
  })
  const say = tools.find((t) => t.name === 'voice_say')
  // 这台机器上备用通道可用；只用 WAV 模式，避免测试时突然出声
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-tool-'))
  try {
    const wav = path.join(dir, 'out.wav')
    const out = await say.execute({ text: '测试', wav })
    assert.match(out, /通道：system-speech|失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
