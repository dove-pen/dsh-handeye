// 语音工具：让 AI 能"出声"。
//
// 只有一个声音出口（voice_say）和一个只读的语音清单（voice_list）。
// 文本走临时文件传参，中文/引号/换行都不会被命令行吃掉。

import { normalizeSayArgs, sayWithFallback } from '../voice.js'
import { fail, text } from './util.js'

export function createVoiceTools({ runHandeye }) {
  return [
    {
      name: 'voice_say',
      description:
        'Speak a short sentence out loud through the system voice, or synthesize it to a WAV file. Use it to report completion or get attention when the user is not looking at the screen. Keep it short and do not read out secrets.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to say (max 300 chars).' },
          voice: { type: 'string', description: 'Optional voice name, e.g. Microsoft Huihui Desktop.' },
          rate: { type: 'number', description: 'Speech rate -10..10, default 0.' },
          volume: { type: 'number', description: 'Volume 0..100, default 100.' },
          wav: { type: 'string', description: 'Optional: write to this .wav file instead of playing it.' },
        },
        required: ['text'],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const normalized = normalizeSayArgs(args ?? {})
        if (!normalized.ok) return fail(`Bad arguments: ${normalized.errors.join('; ')}`)

        const result = await sayWithFallback(normalized.args, { runHandeye })
        if (!result.ok) return fail(`Could not speak (${result.via}): ${result.message}`)
        return result.wav ? `${result.message} (via ${result.via})` : `${result.message}：「${text(normalized.args.text).slice(0, 40)}」（通道：${result.via}）`
      },
    },

    {
      name: 'voice_list',
      description: 'List the system voices available for voice_say.',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute() {
        if (typeof runHandeye !== 'function') return fail('handeye executable is not available')
        const r = await runHandeye(['voices'], { timeoutMs: 15000 })
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
        if (r.code !== 0 || !out) {
          // handeye 的 voices 在一些机器上起不来；退到 PowerShell 的清单
          const { spawnSync } = await import('node:child_process')
          const ps = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + ' / ' + $_.VoiceInfo.Culture }",
            ],
            { encoding: 'utf8', timeout: 20000 },
          )
          const lines = String(ps.stdout ?? '').trim()
          if (!lines) return fail('could not read the voice list')
          return `Available voices (System.Speech):\n${lines}`
        }
        return `Available voices:\n${out}`
      },
    },
  ]
}
