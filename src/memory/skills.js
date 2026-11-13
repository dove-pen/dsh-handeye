// 从"做过几次"到"一份技能草案"。
//
// 纯函数，不碰文件系统：输入几条成功的 episode，输出一份能给人看、给模型照着做的计划。
// **不做自动重放** —— v1 的价值是"不用再教第二遍"，不是"全自动"。

import { buildAnchor } from './anchor.js'

export const DEFAULT_MIN_RUNS = 3
const MAX_STEPS = 40

/** 一次 episode 的"形状"：工具序列 + 目标文本。 */
export function episodeShape(episode) {
  const steps = Array.isArray(episode?.steps) ? episode.steps : []
  return {
    tools: steps.map((s) => String(s?.tool ?? '')).filter(Boolean),
    intent: String(episode?.intent?.text ?? '').trim(),
    ok: episode?.outcome === 'success',
  }
}

/** 两个形状有多像：工具序列逐位比对 + 集合重合，各占一半。 */
export function similarity(a, b) {
  const ta = a?.tools ?? []
  const tb = b?.tools ?? []
  if (!ta.length || !tb.length) return 0
  const len = Math.max(ta.length, tb.length)
  let same = 0
  for (let i = 0; i < Math.min(ta.length, tb.length); i += 1) if (ta[i] === tb[i]) same += 1
  const positional = same / len

  const setA = new Set(ta)
  const setB = new Set(tb)
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter += 1
  const jaccard = inter / (setA.size + setB.size - inter || 1)

  const bothIntents = a?.intent && b?.intent
  const intentBonus = bothIntents && a.intent === b.intent ? 0.15 : 0
  return Math.min(1, positional * 0.55 + jaccard * 0.45 + intentBonus)
}

/** 把相似的 episode 聚成组（只收成功的）。 */
export function clusterEpisodes(episodes, { threshold = 0.8 } = {}) {
  const groups = []
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const shape = episodeShape(episode)
    if (!shape.ok || shape.tools.length === 0) continue
    const home = groups.find((g) => similarity(g.shape, shape) >= threshold)
    if (home) home.episodes.push(episode)
    else groups.push({ shape, episodes: [episode] })
  }
  return groups
}

const LITERAL_KEYS = ['text', 'url', 'value', 'query', 'keyword']

/**
 * 参数抽取（v1 只做"同一位置、多次取值不同 → 参数"）。
 * 不做自动推断：差异过大就放弃这次固化，别把特例当规则。
 */
export function extractParams(runs) {
  const params = []
  const steps = runs[0]?.steps ?? []
  for (let i = 0; i < steps.length; i += 1) {
    const tool = steps[i]?.tool
    const atSameStep = runs.map((r) => r?.steps?.[i]).filter(Boolean)
    if (atSameStep.length < 2) continue
    for (const key of LITERAL_KEYS) {
      const values = atSameStep.map((s) => s?.args?.[key]).filter((v) => typeof v === 'string' && v.trim())
      if (values.length < 2) continue
      const unique = [...new Set(values)]
      if (unique.length <= 1) continue
      // 差异过大（比如路径每次完全不同）不做参数，直接放弃这一步的固化
      if (unique.every((v) => v.length > 40)) continue
      params.push({ name: key, step: i + 1, tool, examples: unique.slice(0, 3), required: true })
    }
  }
  return params
}

function titleOf(group) {
  const text = String(group.episodes[0]?.intent?.text ?? '').trim()
  if (text) return text.slice(0, 60)
  const tools = group.shape.tools.slice(0, 3).join(' → ')
  return `Automation: ${tools}`
}

/**
 * 编译一份技能草案。
 *
 * 每一"步"= 第 i 次工具调用，带：意图、工具、锚点、参数占位、判据（v1 通常为空）。
 * 没有判据的步骤会被标 incomplete —— 不假装它验得过了。
 */
export function compileSkill(group, { now = () => new Date() } = {}) {
  const runs = group.episodes
  const first = runs[0]
  const steps = first?.steps ?? []
  const params = extractParams(runs)
  const paramByStep = new Map()
  for (const p of params) {
    const list = paramByStep.get(p.step - 1) ?? []
    list.push(p.name)
    paramByStep.set(p.step - 1, list)
  }

  const draftSteps = steps.slice(0, MAX_STEPS).map((step, index) => {
    const anchor = step?.anchor ?? buildAnchor(step?.tool, step?.args, step?.brief)
    const templated = { ...(step?.args ?? {}) }
    for (const name of paramByStep.get(index) ?? []) templated[name] = `{{${name}}}`
    // 坐标永远不进模板：技能记的是意图，不是像素
    delete templated.x
    delete templated.y
    return {
      id: `s${index + 1}`,
      intent: describeStep(step, anchor),
      tool: step?.tool ?? '',
      args: templated,
      anchor,
      expect: null, // v1 不从轨迹推断判据；留给用户/模型补
      onFail: 'stop',
    }
  })

  const missingChecks = draftSteps.filter((s) => !s.expect).length
  const fragile = draftSteps.filter((s) => s.anchor?.fragile).length

  return {
    schemaVersion: 1,
    id: `skill_${now().toISOString().slice(0, 10).replace(/-/g, '')}_${String(runs.length).padStart(2, '0')}`,
    title: titleOf(group),
    version: 1,
    origin: {
      kind: 'episode',
      episodeIds: runs.map((r) => r?.id).filter(Boolean),
      createdAt: now().toISOString(),
      author: 'local',
    },
    params: params.map(({ examples, ...rest }) => ({ ...rest, example: examples[0] })),
    steps: draftSteps,
    health: { runs: 0, ok: 0, fail: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
    // 诚实的未完成度：这几步没有判据 / 这几步换屏幕可能失效
    incomplete: { stepsWithoutChecks: missingChecks, fragileSteps: fragile },
  }
}

function describeStep(step, anchor) {
  const tool = String(step?.tool ?? '')
  const args = step?.args ?? {}
  if (anchor?.text) return `${tool}：${anchor.text}`
  if (tool === 'hand_type' && args.text) return `type "${String(args.text).slice(0, 40)}"`
  if (tool === 'browser_navigate' && args.url) return `open ${args.url}`
  if (tool === 'desk_launch' && args.target) return `launch ${args.target}`
  return tool || 'unnamed step'
}

/** 从一堆 episode 里找出值得固化的技能草案。 */
export function compileSkills(episodes, { minRuns = DEFAULT_MIN_RUNS, threshold = 0.8, now } = {}) {
  const groups = clusterEpisodes(episodes, { threshold })
  return groups
    .filter((g) => g.episodes.length >= minRuns)
    .map((g) => compileSkill(g, { now }))
}
