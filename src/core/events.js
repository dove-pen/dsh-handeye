// 执行事件日志：把"手眼到底干了什么"整理成 Windows 事件查看器那种形状。
//
// 为什么重做：原来面板里的"日志"读的是 handeye 的 C++ 日志（OCR 引擎、点击命中这些内部细节），
// 对"AI 干了什么、被拦了几次"这个问题没有回答。这一层要回答的是后者。
//
// 字段对齐 Windows 事件日志：时间 / 级别 / 来源 / 事件ID / 任务类别 / 描述 / 详细信息。
// 级别也照 Windows 的顺序：1 严重、2 错误、3 警告、4 信息、5 详细。

export const LEVELS = {
  1: '严重',
  2: '错误',
  3: '警告',
  4: '信息',
  5: '详细',
}

/** 事件 ID 按来源分段，和 handeye 的做法一致：2xxx 门卫、3xxx 目标、4xxx 动作、5xxx 技能。 */
export const EVENT_IDS = {
  2001: { name: 'gate.refused', category: '门卫', level: 3, desc: '门卫拒绝了一次动作' },
  2002: { name: 'gate.confirm_granted', category: '门卫', level: 2, desc: '批准了一次破坏性动作' },
  3001: { name: 'goal.created', category: '目标', level: 4, desc: '建立了目标' },
  3002: { name: 'goal.step_done', category: '目标', level: 4, desc: '完成了一个步骤' },
  3003: { name: 'goal.step_blocked', category: '目标', level: 3, desc: '步骤连续验收失败被锁' },
  3004: { name: 'goal.completed', category: '目标', level: 4, desc: '目标全部完成' },
  4001: { name: 'tool.ok', category: '动作', level: 4, desc: '动作完成' },
  4002: { name: 'tool.failed', category: '动作', level: 2, desc: '动作失败' },
  5001: { name: 'skill.created', category: '技能', level: 4, desc: '新增了一份技能' },
  5002: { name: 'skill.run_ok', category: '技能', level: 4, desc: '技能跑通一次' },
  5003: { name: 'skill.run_fail', category: '技能', level: 3, desc: '技能失败一次' },
}

const SOURCE_OF_TOOL = [
  [/^(eye_|hand_)/, '手眼'],
  [/^desk_/, '后台控件'],
  [/^browser_/, '浏览器'],
  [/^voice_/, '语音'],
  [/^(goal_|episode_)/, '目标'],
  [/^skill_/, '技能'],
  [/^(card_|capability)/, '卡片'],
  [/^(yl_|plate_)/, '桌面工具'],
  [/^(pack_|skill_use)/, '技能'],
]

export function sourceOf(tool) {
  const name = String(tool ?? '')
  for (const [re, label] of SOURCE_OF_TOOL) if (re.test(name)) return label
  return '其它'
}

function clip(text, max = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 拒绝信息在 brief 里长这样：Refused: GOAL_STEP_REQUIRED — ... */
export function refusalCode(brief) {
  const m = /^Refused:\s*([A-Z_]+)/.exec(String(brief ?? '').trim())
  return m ? m[1] : ''
}

function event({ time, id, source, tool = '', message, detail }) {
  const meta = EVENT_IDS[id] ?? { category: '其它', level: 4, desc: '' }
  return {
    time,
    tool,
    level: meta.level,
    levelText: LEVELS[meta.level],
    source,
    eventId: id,
    category: meta.category,
    message: clip(message),
    detail: typeof detail === 'string' ? detail : Object.entries(detail ?? {}).map(([k, v]) => `${k}=${v}`).join(' '),
  }
}

/**
 * episode 里的每个 step → 一条事件。
 * step 自身没有时间戳，用 startedAt 累加每步耗时推算（顺序是真实的，误差在毫秒级）。
 */
export function episodesToEvents(episodes = []) {
  const out = []
  for (const ep of episodes) {
    let at = Date.parse(ep.startedAt ?? '') || 0
    for (const step of ep.steps ?? []) {
      const ms = Number(step.ms) || 0
      const code = refusalCode(step.brief)
      const id = code ? 2001 : step.ok ? 4001 : 4002
      const message = code ? `拒绝 ${step.tool}：${code} — ${clip(step.brief, 160)}` : `${step.tool}：${clip(step.brief, 160)}`
      out.push(
        event({
          time: at,
          id,
          tool: step.tool ?? '',
          source: code ? '门卫' : sourceOf(step.tool),
          message,
          detail: {
            tool: step.tool,
            ok: step.ok,
            ms,
            code: code || 'none',
            episode: ep.id,
            intent: clip(ep.intent?.text ?? '', 80),
          },
        }),
      )
      at += ms
    }
  }
  return out
}

/** 目标记录 → 事件：完成、被锁、建立。 */
export function goalsToEvents(goals = []) {
  const out = []
  for (const goal of goals) {
    const steps = goal.steps ?? []
    const blocked = steps.filter((s) => s.status === 'blocked')
    for (const step of blocked) {
      out.push(
        event({
          time: Date.parse(goal.updatedAt ?? goal.createdAt ?? '') || 0,
          id: 3003,
          source: '目标',
          message: `步骤 ${step.id} 被锁：${clip(step.title, 60)}`,
          detail: { goal: goal.id, step: step.id, reason: clip(step.blockReason ?? step.lastFailure ?? '', 120) },
        }),
      )
    }
    const allDone = steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'skipped')
    if (allDone) {
      out.push(
        event({
          time: Date.parse(goal.updatedAt ?? '') || 0,
          id: 3004,
          source: '目标',
          message: `目标完成：${clip(goal.title, 60)}`,
          detail: { goal: goal.id, steps: steps.length },
        }),
      )
    }
  }
  return out
}

/** 技能记录 → 事件：按健康度给"跑通/失败"，按创建时间给"新增"。 */
export function skillsToEvents(skills = []) {
  const out = []
  for (const skill of skills) {
    const health = skill.health ?? {}
    const created = Date.parse(skill.origin?.createdAt ?? '') || 0
    const lastRun = Date.parse(skill.health?.lastRunAt ?? '') || 0
    out.push(
      event({
        time: created,
        id: 5001,
        source: '技能',
        message: `技能：${clip(skill.title, 60)}（${(skill.steps ?? []).length} 步）`,
        detail: { skill: skill.id, version: skill.version, status: health.status },
      }),
    )
    if (Number(health.ok) > 0) {
      out.push(
        event({
          time: lastRun || created,
          id: 5002,
          source: '技能',
          message: `技能跑通：${clip(skill.title, 60)}（累计 ok=${health.ok}）`,
          detail: { skill: skill.id, ok: health.ok, fail: health.fail },
        }),
      )
    }
    if (Number(health.fail) > 0) {
      out.push(
        event({
          time: lastRun || created,
          id: 5003,
          source: '技能',
          message: `技能失败：${clip(skill.title, 60)} — ${clip(health.lastFailReason ?? '未记录原因', 100)}`,
          detail: { skill: skill.id, ok: health.ok, fail: health.fail },
        }),
      )
    }
  }
  return out
}

export function buildEvents({ episodes = [], goals = [], skills = [] } = {}) {
  return [...episodesToEvents(episodes), ...goalsToEvents(goals), ...skillsToEvents(skills)]
    .filter((e) => e.time > 0)
    .sort((a, b) => b.time - a.time)
}

/** 按级别、关键词、时间窗过滤。level=warn 表示"警告及以上"（数字更小更严重）。 */
export function filterEvents(events, { level = 'all', q = '', sinceMs = null, untilMs = null } = {}) {
  const minLevel = level === 'all' ? 5 : Number(level) || 5
  const needle = String(q ?? '').trim().toLowerCase()
  return events.filter((e) => {
    if (e.level > minLevel) return false
    if (sinceMs !== null && e.time < sinceMs) return false
    if (untilMs !== null && e.time > untilMs) return false
    if (!needle) return true
    return `${e.message} ${e.detail} ${e.source} ${e.levelText}`.toLowerCase().includes(needle)
  })
}

/** 顶部 KPI 用的计数。 */
export function summarize(events = []) {
  const count = (id) => events.filter((e) => e.eventId === id).length
  return {
    total: events.length,
    actions: count(4001) + count(4002),
    failed: count(4002),
    refused: count(2001),
    errors: events.filter((e) => e.level <= 2).length,
    warnings: events.filter((e) => e.level === 3).length,
  }
}
