// 语义锚点：这一步到底"操作的是什么"，而不是"点在哪个像素"。
//
// 技能层能不能成，全看这里。只有坐标的技能换个屏幕就废；
// 记住"含『免费订阅』的按钮、在 Chrome 主窗口里"才是可迁移的。
//
// v1 是启发式：从参数里找显式文本，从输出里找命中的窗口。
// 拿不到语义线索时**不假装拿到**，标 fragile —— 这个标记会一路传到技能草案上。

const TEXT_KEYS = ['text', 'name', 'label', 'query', 'keyword', 'selector', 'url', 'value', 'target', 'ref']
const CONTAINER_KEYS = ['title', 'window', 'hwndTitle']

const KIND_BY_TOOL = [
  [/^hand_click_text$/, 'click-by-text'],
  [/^hand_click$/, 'click-point'],
  [/^hand_type$/, 'type'],
  [/^hand_key$/, 'key'],
  [/^hand_focus$/, 'focus'],
  [/^desk_invoke$/, 'invoke-control'],
  [/^desk_set_value$/, 'set-value'],
  [/^desk_launch$/, 'launch'],
  [/^browser_navigate$/, 'navigate'],
  [/^browser_click$/, 'click-element'],
  [/^browser_fill$/, 'fill-element'],
  [/^browser_open$/, 'open-browser'],
  [/^eye_/, 'observe'],
  [/^desk_(windows|tree|find|text)$/, 'observe'],
]

export function anchorKind(tool) {
  const name = String(tool ?? '')
  for (const [re, kind] of KIND_BY_TOOL) if (re.test(name)) return kind
  return 'other'
}

/**
 * @param {string} tool
 * @param {object} args 工具参数（原始，含坐标）
 * @param {string} output 工具输出（人类可读文本）
 * @returns {{kind:string, text:string, container:string, point:object|null, fragile:boolean, source:string}}
 */
export function buildAnchor(tool, args = {}, output = '') {
  const kind = anchorKind(tool)
  const anchor = { kind, text: '', container: '', point: null, fragile: true, source: 'none' }

  // 1) 参数里的语义文本（最强：这是"我要找什么"的原话）
  for (const key of TEXT_KEYS) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) {
      anchor.text = value.trim().slice(0, 90)
      anchor.source = `args.${key}`
      anchor.fragile = false
      break
    }
  }

  // 2) 容器：优先显式 title 参数，其次输出里的命中/目标窗口
  for (const key of CONTAINER_KEYS) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) {
      anchor.container = value.trim().slice(0, 60)
      break
    }
  }
  if (!anchor.container) {
    const text = String(output ?? '')
    const hit = /hit window[:：]\s*(.+)/.exec(text) || /target window[:：]\s*(.+)/.exec(text)
    if (hit) anchor.container = hit[1].trim().slice(0, 60)
  }
  const hasSemanticText = anchor.source !== 'none'

  // 3) 坐标：记下来但没有迁移价值
  if (!hasSemanticText && Number.isFinite(args?.x) && Number.isFinite(args?.y)) {
    anchor.point = { x: Math.round(args.x), y: Math.round(args.y) }
    anchor.source = 'args.coords'
  }

  // 4) 只有"知道窗口名"不足以让它可迁移：按坐标点的操作，换分辨率就废。
  //    真正能跨机器的是"找含某文字的控件"，所以脆弱性只由语义文本决定。
  if (anchor.container && !hasSemanticText && kind !== 'click-point') {
    anchor.source = 'output.window'
  }
  anchor.fragile = !hasSemanticText

  return anchor
}

/** 给人看的一句话（面板里显示的就是这个）。 */
export function describeAnchor(anchor) {
  if (!anchor) return '(no anchor)'
  const bits = []
  if (anchor.text) bits.push(`find "${anchor.text}"`)
  if (anchor.container) bits.push(`inside "${anchor.container}"`)
  if (!bits.length && anchor.point) bits.push(`at (${anchor.point.x},${anchor.point.y})`)
  if (!bits.length) bits.push(anchor.kind)
  if (anchor.fragile) bits.push('(may break if the screen or window changes)')
  return bits.join(' ')
}
