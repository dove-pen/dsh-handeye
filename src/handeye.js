// handeye 子进程封装：调用、超时、JSON 解析、退出码翻译。
//
// handeye 是独立 exe，插件只负责"发命令、收结果、再投影"。
// 这样杨镜的 L0/L1/L2 可以立刻落地，不必等 core.lib 抽出来。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 优先用插件自带的 bin\handeye.exe（2026-11-06 起内嵌），
// 其次环境变量，最后才回退到旧位置。这样插件可以独立存在，不依赖 D:\MouseRobot。
const LOCAL_EXE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handeye.exe')
const LEGACY_EXE = 'D:\\MouseRobot\\handeye.exe'

export function exePath() {
  if (process.env.HANDEYE_EXE) return process.env.HANDEYE_EXE
  if (existsSync(LOCAL_EXE)) return LOCAL_EXE
  return LEGACY_EXE
}

const CODE_MEANING = {
  0: '成功',
  1: '参数错误或未找到目标',
  2: '文件错误',
  3: '执行失败',
  4: '超时或被停止',
  5: '动作做了但验证没通过',
}

export function codeMeaning(code) {
  return CODE_MEANING[code] || `未知退出码 ${code}`
}

/**
 * 跑一条 handeye 命令，永远 resolve（不 reject），由调用方决定怎么处理失败。
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string}>}
 */
export function runHandeye(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const exe = exePath()
    if (!existsSync(exe)) {
      resolve({
        ok: false,
        code: -1,
        stdout: '',
        stderr: `找不到 handeye.exe：${exe}（可用环境变量 HANDEYE_EXE 指定路径）`,
      })
      return
    }
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const killed = !!(err && err.killed)
        let code = 0
        if (err) {
          code = typeof err.code === 'number' ? err.code : killed ? 4 : 3
          if (killed) code = 4
        }
        resolve({
          ok: code === 0,
          code,
          stdout: stdout || '',
          stderr: stderr || (err ? String(err.message) : ''),
        })
      },
    )
  })
}

/** 跑一条命令并要求它输出 JSON；失败时抛带中文原因的错。 */
export async function runHandeyeJson(args, opts) {
  const r = await runHandeye(args, opts)
  const text = (r.stdout || '').trim()
  if (!r.ok && !text) {
    throw new Error(`handeye ${args.join(' ')} 失败（${codeMeaning(r.code)}）${r.stderr ? '：' + r.stderr.trim() : ''}`)
  }
  if (!text) throw new Error(`handeye ${args.join(' ')} 没有输出`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`handeye 输出不是 JSON：${text.slice(0, 200)}`)
  }
  if (json && json.ok === false) {
    throw new Error(`handeye 报告失败：${json.error || JSON.stringify(json).slice(0, 200)}`)
  }
  return json
}
