// 语音播报：优先用 handeye 的 say，它不行就退到 Windows 的 System.Speech。
//
// 为什么要两条路：这台机器上 `handeye say` 会报 "Internal Speech Error"
// （WinRT 语音合成在这个上下文里起不来），而 System.Speech 能正常列出并使用
// Huihui / Zira / Hazel。**能力要在，路径可以退。**
//
// 文本一律走临时文件传递，不拼进命令行：中文、引号、换行都不会被 PowerShell 吃掉。

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PS = process.env.DSH_HANDEYE_PS || 'powershell.exe'
const MAX_TEXT = 300

const PS_SCRIPT = `
param([string]$TextFile, [string]$Voice, [int]$Rate = 0, [int]$Volume = 100, [string]$Wav)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice) {
    try { $s.SelectVoice($Voice) } catch { }
  } else {
    # 没有指定就优先中文
    $zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
    if ($zh) { try { $s.SelectVoice($zh.VoiceInfo.Name) } catch { } }
  }
  $s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $s.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  if ($Wav) {
    $s.SetOutputToWaveFile($Wav)
    $s.Speak($text)
    $s.SetOutputToNull()
    Write-Output 'WAV_OK'
  } else {
    $s.Speak($text)
    Write-Output 'SPOKEN'
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('ERR ' + $_.Exception.Message)
  exit 3
}
`

function run(command, args, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, env: env ?? process.env })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
      return
    }
    let out = ''
    let errOut = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ code: -1, stdout: out, stderr: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (errOut += d.toString()))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out, stderr: errOut })
    })
  })
}

export function normalizeSayArgs({ text, voice, rate, volume, wav } = {}) {
  const errors = []
  const body = String(text ?? '').trim()
  if (!body) errors.push('text 不能为空')
  if (body.length > MAX_TEXT) errors.push(`text 最多 ${MAX_TEXT} 字（现在是 ${body.length}）`)

  const rateNum = rate === undefined || rate === null ? 0 : Number(rate)
  if (!Number.isFinite(rateNum) || rateNum < -10 || rateNum > 10) errors.push('rate 必须是 -10..10 之间的数字')

  const volNum = volume === undefined || volume === null ? 100 : Number(volume)
  if (!Number.isFinite(volNum) || volNum < 0 || volNum > 100) errors.push('volume 必须是 0..100 之间的数字')

  return {
    ok: errors.length === 0,
    errors,
    args: {
      text: body,
      voice: typeof voice === 'string' && voice.trim() ? voice.trim() : '',
      rate: Number.isFinite(rateNum) ? Math.round(rateNum) : 0,
      volume: Number.isFinite(volNum) ? Math.round(volNum) : 100,
      wav: typeof wav === 'string' && wav.trim() ? wav.trim() : '',
    },
  }
}

/**
 * 说一句话。先试 handeye（原生），失败就退到 System.Speech。
 * @returns {Promise<{ok:boolean, via:'handeye'|'system-speech', message:string, wav?:string}>}
 */
export async function sayWithFallback(args, { runHandeye, runPs } = {}) {
  const { wav } = args
  const handeyeArgs = ['say', args.text]
  if (args.voice) handeyeArgs.push('--voice', args.voice)
  if (args.rate) handeyeArgs.push('--rate', String(args.rate))
  if (args.volume !== 100) handeyeArgs.push('--volume', String(args.volume))
  if (wav) handeyeArgs.push('--wav', wav)

  if (typeof runHandeye === 'function') {
    try {
      const r = await runHandeye(handeyeArgs, { timeoutMs: 30000 })
      if (r && r.code === 0 && !/ERR/i.test(String(r.stderr ?? ''))) {
        return { ok: true, via: 'handeye', message: wav ? `已合成到 ${wav}` : '已播报' }
      }
    } catch {
      // 落到下面的备用通道
    }
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'he-say-'))
  const textFile = path.join(dir, 'say.txt')
  const scriptFile = path.join(dir, 'say.ps1')
  try {
    writeFileSync(textFile, args.text, 'utf8')
    writeFileSync(scriptFile, PS_SCRIPT, 'utf8')
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-TextFile', textFile, '-Rate', String(args.rate), '-Volume', String(args.volume)]
    if (args.voice) psArgs.push('-Voice', args.voice)
    if (wav) psArgs.push('-Wav', wav)

    const runner = typeof runPs === 'function' ? runPs : (cmd, argv, opts) => run(cmd, argv, opts)
    const r = await runner(PS, psArgs, { timeoutMs: 45000 })
    if (r.code === 0 && /(SPOKEN|WAV_OK)/.test(r.stdout)) {
      if (wav && (!existsSync(wav) || readFileSync(wav).length === 0)) {
        return { ok: false, via: 'system-speech', message: `合成完成但没有生成有效 WAV：${wav}` }
      }
      return { ok: true, via: 'system-speech', message: wav ? `已合成到 ${wav}` : '已播报（System.Speech）' }
    }
    return { ok: false, via: 'system-speech', message: (r.stderr || r.stdout || '语音合成失败').trim().slice(0, 200) }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}
