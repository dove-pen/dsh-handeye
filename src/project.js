// 杨镜的投影层：把 handeye 的原始观测（常常 60~80 行 OCR）压成 AI 真正需要的那一点。
//
// 三条铁律（来自 docs\杨镜-设计文档.md §6.1）：
//   1. 投影，不是摘要。只删不编，同输入必然同输出。
//   2. 报警通道永不降采样。对话框、错误词、数字变化行、新窗口，任何级别都原样给。
//   3. 确定性：不调用模型、不做语义判断。
//
// 三级视图：
//   L0  ≤ 3 行：这是什么界面、有几个可操作入口
//   L1  ~10 行：区块 + 控件 + 粗略位置
//   L2  全量：坐标、原始行、窗口
export const LEVELS = ['auto', 'L0', 'L1', 'L2']

const ERROR_WORDS = [
  '错误', '失败', '警告', '无法', '拒绝', '异常', '超时', '不支持',
  'error', 'failed', 'warning', 'unable', 'refused', 'exception', 'timed out', 'unsupported',
  'error', 'failed', 'failure', 'denied', 'cannot', 'warning', 'timeout', 'refused',
]

const CLICKABLE_KINDS = new Set(['button', 'toolbar', 'dialog'])
export const MAX_L1_CHARS = 4000

function hasErrorWord(text) {
  const s = String(text || '').toLowerCase()
  return ERROR_WORDS.some((w) => s.includes(w))
}

/** 坐标粗化到 10 像素，避免把精确像素喂给模型。 */
function coarse(n) {
  return Math.round(Number(n) / 10) * 10
}

function at(item) {
  return `@(${coarse(item.x)},${coarse(item.y)})`
}

function firstLine(text, max = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 拆出报警项：对话框整块、含错误词的条目。 */
export function findAlarms(view) {
  const alarms = []
  for (const b of view.blocks || []) {
    if (b.kind === 'dialog') {
      const text = (b.items || []).map((i) => i.text).join(' / ')
      alarms.push(`[alarm] dialog "${firstLine(b.window || text, 40)}"${text ? '：' + firstLine(text, 80) + ' ' + at(b.items?.[0] || b.box) : ''}`)
      continue
    }
    for (const it of b.items || []) {
      if (hasErrorWord(it.text)) {
        alarms.push(`[alarm] error word "${firstLine(it.text, 70)}"${at(it)}`)
      }
    }
  }
  return alarms
}

function summarizeKinds(blocks) {
  const count = new Map()
  for (const b of blocks) count.set(b.kind, (count.get(b.kind) || 0) + 1)
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(' ')
}

/** L0：一句话说清这是什么界面。 */
export function projectL0(view, alarms) {
  const blocks = view.blocks || []
  const clickable = blocks.filter((b) => CLICKABLE_KINDS.has(b.kind))
  const n = clickable.reduce((s, b) => s + (b.items || []).length, 0)
  const focus = firstLine(view.focus || '(unknown)', 50)
  const kinds = summarizeKinds(blocks)
  // 自绘界面（Chrome、Electron、Qt）的按钮不会被判成 button，直接报"可点 0 项"
  // 会让模型以为没入口。带上解释和替代工具，别让数字说假话。
  const hint = n === 0 && blocks.length > 0 ? '(custom-drawn UI; controls cannot be enumerated - use eye_find / hand_click_text)' : ''
  const head = `[L0] focus "${focus}" | ${blocks.length} blocks (${kinds || 'none'}) | ${n} clickable${hint} | ${view.rawLines ?? '?'} raw lines`
  return [head, ...alarms]
}

/**
 * 按预算截断 L1 输出：保第一行（头）和所有报警行，其余从尾部开始丢。
 * 旧实现是从头部往下砍，先丢的正好是头行和排在前面的可点控件。
 */
export function truncateLines(lines, max = MAX_L1_CHARS) {
  if (!lines.length) return lines
  if (lines.join('\n').length <= max) return lines
  const isAlarm = (l) => l.startsWith('[alarm]')
  const marker = '[truncated by budget; use eye_see level=L2 for the full view]'
  const keep = new Set([0])
  let used = lines[0].length + 1
  for (let i = 1; i < lines.length; i += 1) {
    if (isAlarm(lines[i])) {
      keep.add(i)
      used += lines[i].length + 1
    }
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (keep.has(i)) continue
    if (used + lines[i].length + 1 + marker.length + 1 > max) break
    keep.add(i)
    used += lines[i].length + 1
  }
  const out = lines.filter((_, i) => keep.has(i))
  out.push(marker)
  return out
}

/** L1：区块 + 控件 + 粗略位置。 */
export function projectL1(view, alarms) {
  const blocks = view.blocks || []
  const lines = []
  lines.push(
    `[L1] 焦点「${firstLine(view.focus || '(unknown)', 50)}」| 屏幕 ${view.screen?.w}x${view.screen?.h} | 原始 ${view.rawLines ?? '?'} 行`,
  )
  lines.push(...alarms)

  const clickable = blocks.filter((b) => CLICKABLE_KINDS.has(b.kind))
  for (const b of clickable) {
    for (const it of b.items || []) {
      lines.push(`[${b.kind}] ${firstLine(it.text, 70)} ${at(it)}`)
    }
  }

  // 正文合并成段落，只给首行和块数，别逐行喂。
  // 按面积从大到小取：主内容区通常最大，侧栏/状态栏只占一小块。
  const content = blocks
    .filter((b) => !CLICKABLE_KINDS.has(b.kind))
    .map((b, i) => ({ b, i, area: (b.box?.w ?? 0) * (b.box?.h ?? 0) }))
    .sort((x, y) => y.area - x.area || x.i - y.i)
    .map((x) => x.b)
  let shown = 0
  for (const b of content) {
    const text = (b.items || []).map((i) => i.text).join(' ')
    if (!text.trim()) continue
    if (shown < 6) {
      lines.push(`[${b.kind}] ${firstLine(text, 90)} ${b.items?.[0] ? at(b.items[0]) : ''}`)
      shown += 1
    }
  }
  if (content.length > shown) {
    lines.push(`[${content.length - shown} more blocks omitted; see L2 or use eye_find]`)
  }

  // 超预算就砍正文，但报警行和头行一条都不动。
  return truncateLines(lines, MAX_L1_CHARS)
}

/** 按级别投影；auto 默认 L0，有报警时仍给 L0 但报警行全带。 */
export function project(view, level = 'auto', raw = false) {
  const want = LEVELS.includes(level) ? level : 'auto'
  const alarms = findAlarms(view)
  if (raw) return [JSON.stringify(view, null, 2)]
  if (want === 'L2') {
    return [JSON.stringify(view, null, 2)]
  }
  if (want === 'L1') return projectL1(view, alarms)
  return projectL0(view, alarms)
}

/** 人读的一行摘要，给工具结果头用。 */
export function headline(view) {
  const d = view.delta || {}
  const changed = d.changed ? `changed +${d.added ?? 0}/-${d.removed ?? 0}` : 'no change'
  return `screen ${view.screen?.w}x${view.screen?.h} | ${view.rawLines ?? '?'} raw lines | ${changed}`
}
