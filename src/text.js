// 文字瘦身（杨镜 §6.3）：只做确定性的事，不做摘要。
//
// 顺序固定：规范化 → 去重 → 去噪 → 预算（保头保尾）→ 统计。
// 三条纪律：
//   - 幂等：已经带 (xN) 的行不会被翻倍
//   - 报警行不吃预算：错误词行即使超预算也全留
//   - 同输入必然同输出
const ERROR_WORDS = [
  '错误', '失败', '警告', '无法', '拒绝', '异常', '超时', '不支持',
  'error', 'failed', 'failure', 'denied', 'cannot', 'warning', 'timeout',
]

const NOISE_RE = /^[\s\-=*_~#.·—–]{3,}$/
const COUNT_RE = /^(.*?)\s\(x(\d+)\)$/

function isAlarmLine(line) {
  const s = line.toLowerCase()
  return ERROR_WORDS.some((w) => s.includes(w))
}

function isNoiseLine(line) {
  const t = line.trim()
  if (t === '') return true
  return NOISE_RE.test(t)
}

/** 拆出 "正文 (xN)" 的基础部分，用于幂等合并。 */
function splitCount(line) {
  const m = COUNT_RE.exec(line)
  if (m) return { base: m[1], count: Number(m[2]) }
  return { base: line, count: 1 }
}

/**
 * @param {string} input 原文
 * @param {{budget?:number, dedupe?:boolean, noise?:boolean}} opts
 */
export function slimText(input, opts = {}) {
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? Math.floor(opts.budget) : 4000
  const doDedupe = opts.dedupe !== false
  const doNoise = opts.noise !== false

  const normalized = String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')

  const rawLines = normalized.split('\n')
  const stats = {
    lines_in: rawLines.length,
    chars_in: [...normalized].length,
    deduped: 0,
    noise: 0,
    omitted_lines: 0,
    omitted_chars: 0,
    alarms_kept: 0,
  }

  // 去噪 + 去重（相邻合并）
  const kept = []
  let prevKey = null
  let prevCount = 1
  for (const line of rawLines) {
    if (doNoise && isNoiseLine(line)) {
      stats.noise += 1
      continue
    }
    if (!doDedupe) {
      kept.push(line)
      continue
    }
    const { base, count } = splitCount(line)
    const key = base.replace(/\s+$/, '')
    if (prevKey !== null && key === prevKey) {
      prevCount += count
      stats.deduped += 1
      continue
    }
    if (prevKey !== null) {
      kept.push(prevCount > 1 ? `${prevKey} (x${prevCount})` : prevKey)
    }
    prevKey = key
    prevCount = count
  }
  if (prevKey !== null) {
    kept.push(prevCount > 1 ? `${prevKey} (x${prevCount})` : prevKey)
  }

  // 预算：报警行全留，其余保头保尾
  const alarmIdx = []
  const restIdx = []
  kept.forEach((line, i) => (isAlarmLine(line) ? alarmIdx.push(i) : restIdx.push(i)))
  stats.alarms_kept = alarmIdx.length

  const totalChars = kept.reduce((s, l) => s + [...l].length + 1, 0)
  if (totalChars <= budget) {
    const out = kept.join('\n')
    return { text: out, stats: { ...stats, chars_out: [...out].length, lines_out: kept.length }, trimmed: false }
  }

  // 先把报警行全部占位，剩下的预算按 6:4 分给头尾
  const alarmChars = alarmIdx.reduce((s, i) => s + [...kept[i]].length + 1, 0)
  let remain = Math.max(0, budget - alarmChars)
  const headBudget = Math.floor(remain * 0.6)
  const tailBudget = remain - headBudget

  const head = []
  let used = 0
  for (const i of restIdx) {
    const len = [...kept[i]].length + 1
    if (used + len > headBudget) break
    head.push(i)
    used += len
  }
  const tail = []
  used = 0
  for (let k = restIdx.length - 1; k >= 0; k--) {
    const i = restIdx[k]
    const len = [...kept[i]].length + 1
    if (used + len > tailBudget) break
    if (head.includes(i)) break
    tail.unshift(i)
    used += len
  }

  const headSet = new Set(head)
  const tailSet = new Set(tail)
  const omitted = kept.filter((_, i) => !alarmIdx.includes(i) && !headSet.has(i) && !tailSet.has(i))

  const outLines = []
  let insertedMarker = false
  for (let i = 0; i < kept.length; i++) {
    if (alarmIdx.includes(i) || headSet.has(i) || tailSet.has(i)) {
      outLines.push(kept[i])
      continue
    }
    if (!insertedMarker) {
      const chars = omitted.reduce((s, l) => s + [...l].length + 1, 0)
      outLines.push(`[省略 ${omitted.length} 行 / ${chars} 字符]`)
      insertedMarker = true
    }
  }

  stats.omitted_lines = omitted.length
  stats.omitted_chars = omitted.reduce((s, l) => s + [...l].length + 1, 0)

  const out = outLines.join('\n')
  return {
    text: out,
    stats: { ...stats, chars_out: [...out].length, lines_out: outLines.length },
    trimmed: true,
  }
}
