// dsh-handeye 插件入口。
//
// 把三样东西收进一个插件：
//   1. handeye 的手（点、打、按键、切窗口）
//   2. 杨镜的看（L0/L1/L2 三级投影、报警永不降采样、文字瘦身、账本）
//   3. dsh-computer-use-win 的路数（UIA 后台按控件、批量动作、截图只给路径）
//
// 设计原则：能用后台控件就不用鼠标；能按名字就不用坐标；能投影就不喂原文。
import { readFileSync, readdirSync, existsSync, statSync, unlinkSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createState, noteAction, beginEpisode, beginGoalStep, endGoalStep, countStepAction, grantStepBudget } from './core/state.js'
import { canAct } from './core/gate.js'
import { isActionTool, isMetaTool } from './core/risk.js'
import { runChecks, normalizeChecks, COMMAND_ALLOWLIST } from './core/verify.js'
import { redactDeep, redactText } from './memory/redact.js'
import { createEpisodeStore, newEpisodeId } from './memory/episodes.js'
import { createCapabilityStore } from './memory/capabilities.js'
import { createCardStore } from './memory/cards.js'
import { createGoalStore } from './memory/goals.js'
import { createSkillStore } from './memory/skillStore.js'
import { createSkillTools } from './tools/skills.js'
import { createTutorialTools } from './tools/tutorials.js'
import { createVoiceTools } from './tools/voice.js'
import { createGoalTools } from './tools/goals.js'
import { createConfirmStore } from './runtime/confirm.js'
import { createExecutor } from './runtime/executor.js'
import { createOps } from './runtime/ops.js'
import { createPrimitives } from './runtime/primitives.js'
import { createMetaTools } from './tools/meta.js'
import { createCapabilityTool } from './tools/capability.js'
import { registerRoutes } from './api/routes.js'
import { createToolServer } from './server/toolServer.js'
import { buildAnchor } from './memory/anchor.js'
import { runHandeye, runHandeyeJson, exePath, codeMeaning } from './handeye.js'
import { project, headline, findAlarms } from './project.js'
import { slimText } from './text.js'
import {
  listWindows,
  treeOf,
  textOf,
  invokeRef,
  setValueRef,
  focusRef,
  launchApp,
  batchActions,
  formatTree,
  findControls,
} from './desk.js'
import {
  openUrl,
  navigate,
  snapshot,
  clickIndex,
  fillIndex,
  pageText,
  listTabs,
  closeTab,
  stopBrowser,
  ensureBrowser,
  browserPort,
  browserMode,
  isAttached,
  attachBrowser,
  detachBrowser,
  discoverEndpoints,
} from './browser.js'
import {
  clickAt,
  focusWindowTarget,
  windowAt,
  listTopWindows,
  cropRegion,
  grabRegion,
  resolveTarget,
  describeWindow,
  pickWindowByTitle,
  formatClickResult,
  formatFocusResult,
  parseRegion,
  WinUiError,
} from './winui.js'
import {
  waitForText,
  waitForGone,
  waitForChange,
  readRegion,
  formatWaitResult,
} from './eye.js'

export const name = 'dsh-handeye'
// cordis 要求显式声明依赖，否则 ctx.tools 取不到（会报 cannot get property "tools" without inject）。
export const inject = ['tools']

// 自己的版本号，给活动面板显示用。
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  } catch {
    return { version: '0.0.0' }
  }
})()

const ok = (s) => String(s ?? '')

// 每个工具都必须声明输出契约（schema + render），否则注册时直接报错。
// 我们的工具一律返回文本，所以统一一个声明就够了。
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

// 活动记录：给界面用的"刚才做了什么"。只放内存，最多 200 条，进程重启即清空。
// 这是给人看的，不是为了审计——真要审计去查 handeye 的七段日志（yl_log）。
// 门卫拒绝计数（按错误码）。/metrics 用它算"拦下越界"这类数字。
const REFUSALS = Object.create(null)
function noteRefusal(code) {
  if (!code) return
  REFUSALS[code] = (REFUSALS[code] || 0) + 1
}

const ACTIVITY = []
const ACTIVITY_MAX = 200

function clip(s, n = 90) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function recordActivity(tool, args, ok, brief, ms) {
  let argText = ''
  try {
    argText = args && Object.keys(args).length ? clip(JSON.stringify(args), 60) : ''
  } catch {
    argText = ''
  }
  ACTIVITY.push({ t: new Date().toISOString(), tool, args: argText, ok, brief: clip(brief, 240), ms })
  if (ACTIVITY.length > ACTIVITY_MAX) ACTIVITY.splice(0, ACTIVITY.length - ACTIVITY_MAX)
}

// 运行时会话（状态机、存储、执行器）。apply 时创建，工具层通过它过闸。
let RUNTIME = null

/** 主机无关的工具服务器：调用、门卫、记账都在这里，宿主只负责注册与转发。 */
let toolServer = null

// 破坏性动作的人工确认：面板上点"允许一次"写这里，下一次同工具调用消费掉。
// 刻意只放在内存里 —— 重启即失效，不留下可被复用的长期授权。
const GRANT_MS = 120000
let PENDING_CONFIRM = null
let GRANTED = null

function notePendingConfirm(tool, args) {
  PENDING_CONFIRM = { tool: String(tool), args: redactDeep(args && typeof args === 'object' ? args : {}), at: new Date().toISOString() }
}

let GRANT_FILE = null

function readGrantFile() {
  if (!GRANT_FILE) return null
  try {
    const doc = JSON.parse(readFileSync(GRANT_FILE, 'utf8'))
    if (!doc || typeof doc.tool !== 'string' || typeof doc.expiresAt !== 'number') return null
    if (Date.now() > doc.expiresAt) {
      try {
        rmSync(GRANT_FILE, { force: true })
      } catch {}
      return null
    }
    return doc
  } catch {
    return null
  }
}

function consumeGrantFile(tool) {
  const doc = readGrantFile()
  if (!doc || doc.tool !== String(tool)) return false
  try {
    rmSync(GRANT_FILE, { force: true })
  } catch {}
  return true
}

function grantConfirm(tool) {
  GRANTED = { tool: String(tool), expiresAt: Date.now() + GRANT_MS }
  // 同时写盘：CLI 的 confirm 与真正调用可能在不同进程
  if (GRANT_FILE) {
    try {
      writeFileSync(GRANT_FILE, JSON.stringify({ tool: GRANTED.tool, expiresAt: GRANTED.expiresAt }, null, 2), 'utf8')
    } catch {}
  }
  return { tool: GRANTED.tool, expiresAt: new Date(GRANTED.expiresAt).toISOString() }
}

function takeGrant(tool) {
  if (GRANTED && GRANTED.tool === String(tool) && Date.now() <= GRANTED.expiresAt) {
    GRANTED = null
    PENDING_CONFIRM = null
    // 内存里用掉了，盘上的那张票也必须一起作废 ——
    // 否则会是"一次授权被用两次"：本进程放行一次，下一个进程又白捡一次（实测踩过）
    if (GRANT_FILE) {
      try {
        rmSync(GRANT_FILE, { force: true })
      } catch {}
    }
    return true
  }
  if (GRANTED && Date.now() > GRANTED.expiresAt) GRANTED = null
  // 跨进程的一次性票
  if (consumeGrantFile(tool)) {
    PENDING_CONFIRM = null
    return true
  }
  return false
}
// 当前正在记录的 episode（内存里攒，结束后写盘）。
let ACTIVE = null

async function flushActive(outcome = 'success') {
  if (!ACTIVE || !RUNTIME) return
  const episode = ACTIVE
  ACTIVE = null
  episode.endedAt = new Date().toISOString()
  episode.outcome = outcome
  const saved = await RUNTIME.episodes.append(episode)
  if (!saved.ok) RUNTIME.logger?.warn?.(`episode flush failed: ${saved.message}`)
}

function startActiveEpisode({ id, intent }) {
  void flushActive('superseded')
  ACTIVE = {
    id,
    startedAt: new Date().toISOString(),
    intent: { text: String(intent ?? ''), source: 'model' },
    steps: [],
    outcome: 'running',
  }
}

function reg(ctx, def) {
  // 真正的调用/门卫/记账逻辑在 server/toolServer.js 里，这里只做注册。
  // 宿主（DSH / MCP / CLI）都走同一个 callTool，门卫只有一份。
  ctx.tools.register({ output: TEXT_OUTPUT, ...toolServer.wrap(def) })
}

function fail(prefix, err) {
  return `${prefix}：${err instanceof Error ? err.message : String(err)}`
}

/**
 * 适配层（MCP / CLI）用它拿运行时：确认通道需要 grantConfirm。
 * 不导出更多东西 —— 运行时是内部状态，不是公开 API。
 */
export function getRuntime() {
  return RUNTIME
}

export function apply(ctx) {
  // ------------------------------------------------------------ 运行时会话
  //
  // 状态机、episode 存储、能力仓库、确认令牌、执行器。数据放在本地应用目录，
  // 不进 profile：卸载插件不该顺手删掉用户的操作记忆。
  const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-handeye-plus')
  GRANT_FILE = path.join(dataDir, 'grant-once.json')
  // 门卫/记账逻辑集中在一个与宿主无关的地方；这里只把它的依赖注入进去。
  toolServer = createToolServer({
    ports: {
      runtime: () => RUNTIME,
      active: () => ACTIVE,
      isMetaTool,
      isActionTool,
      canAct,
      takeGrant,
      notePendingConfirm,
      noteRefusal,
      recordActivity,
      redactDeep,
      redactText,
      clip,
      noteAction,
      countStepAction,
      buildAnchor,
    },
  })

  const runtimeState = createState()
  const episodes = createEpisodeStore({ dir: dataDir })
  // prune() 一直没人调用，episodes 的 jsonl 会无限长下去（一个动作一行）。
  // 启动时清一次旧日子，失败也不影响本次运行。
  void episodes.prune({}).catch(() => {})
  const capabilities = createCapabilityStore({ dir: dataDir })
  const cards = createCardStore({ dir: dataDir })
  const goals = createGoalStore({ dir: dataDir })
  const skills = createSkillStore({ dir: dataDir })
  const confirmStore = createConfirmStore()
  const primitives = createPrimitives()
  const ops = createOps({ primitives })
  const executor = createExecutor({ state: runtimeState, ops, confirm: confirmStore })
  RUNTIME = {
    state: runtimeState,
    episodes,
    capabilities,
    cards,
    goals,
    skills,
    confirm: confirmStore,
    executor,
    dataDir,
    logger: ctx.logger,
    /** 破坏性动作的待确认请求（给面板显示"允许一次"）。 */
    pendingConfirm: () => PENDING_CONFIRM,
    grantConfirm,
    /** Gate refusal counters, read by /metrics. */
    refusals: () => ({ ...REFUSALS }),
    /** Called by the UI when a task card is sent: no extra model round-trip. */
    async startEpisode(intent, opts = {}) {
      const id = newEpisodeId(new Date())
      beginEpisode(runtimeState, intent, {
        episodeId: id,
        allowedTools: opts.allowedTools,
        path: opts.path,
        cardId: opts.cardId,
        verify: opts.verify,
        params: opts.params,
      })
      startActiveEpisode({ id, intent })
      // 卡片带 verify 但调用方没展开时，自己补上；等挂完再返回，避免竞态
      if (opts.cardId && !(Array.isArray(opts.verify) && opts.verify.length > 0)) {
        await applyCardToState(opts.cardId)
      }
      return id
    },
  }
  try {
    ctx.effect(() => () => {
      void flushActive('unloaded')
    })
  } catch { }

  // ------------------------------------------------------------ 验收引擎接线
  //
  // P0：把"我觉得做完了"换成"机器验过了"。
  // 判据来自任务卡片的 verify 字段；没写 verify 的卡片，episode 行为和以前一模一样。
  //
  // 人工放行的口子**故意不暴露成工具**：如果模型能自己放行，这道门就白做了。
  // 用户往 override.json 里写一条 {episodeId, reason}，下一次 checkpoint 消费掉就失效。
  const OVERRIDE_FILE = path.join(dataDir, 'override.json')

  function parseJsonLoose(textValue) {
    const first = String(textValue ?? '').trim().split(/\r?\n/, 1)[0]
    if (!first) return null
    try {
      return JSON.parse(first)
    } catch {
      return null
    }
  }

  /**
   * 判据配置写坏时的兜底。必须是"一定验不过"的判据：
   * 早期版本这里写成了 exit + echo，退出码 0 反而通过，等于把门打开。
   */
  function brokenChecks(errors) {
    return [
      {
        type: 'file',
        path: '__broken_checks_config__',
        minBytes: 1,
        broken: errors.map((e) => `${e.path} ${e.message}`).join('；'),
      },
    ]
  }

  function runCommand(command, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const raw = String(command)
      // cmd.exe /c 会解释 & | > < ^ 这些元字符，白名单只看第一个 token 是拦不住的：
      // "node -v & del /f x" 的 head 也是 node。含元字符一律拒。
      if (/[&|<>^%!;\`$]/.test(raw)) {
        resolve({ code: -1, stdout: '', stderr: 'command rejected: shell metacharacters are not allowed' })
        return
      }
      const head = raw.trim().split(/\s+/, 1)[0].toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
      // 第二道锁：normalizeChecks 已经拦过一次，这里再拦一次，防止别处直接调用
      if (!COMMAND_ALLOWLIST.includes(head)) {
        resolve({ code: -1, stdout: '', stderr: `命令「${head}」不在白名单里` })
        return
      }
      let out = ''
      let errOut = ''
      let child
      try {
        child = spawn('cmd.exe', ['/c', command], { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { }
      }, Math.max(1000, Math.min(120000, timeoutMs)))
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { errOut += String(d) })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout: out, stderr: e instanceof Error ? e.message : String(e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code === null ? -1 : code, stdout: out, stderr: errOut })
      })
    })
  }

  const verifyDeps = {
    exists: async (p) => existsSync(p),
    size: async (p) => {
      try { return statSync(p).size } catch { return 0 }
    },
    readText: async (p) => {
      // 读失败必须抛错：返回空串会让 absent 判据把"读不到"判成"没出现"=通过
      return readFileSync(p, 'utf8')
    },
    // 屏幕类判据复用眼层：能看见的文字才算数，不另起一套 OCR
    screenText: async (region) => {
      const argv = ['see', '--json', '--best', '--max-lines', '60']
      if (region) argv.push('--region', region)
      const r = await runHandeye(argv, { timeoutMs: 45000 })
      const j = parseJsonLoose(r.stdout)
      if (!j) return ''
      const parts = []
      for (const block of j.blocks || []) {
        for (const item of block.items || []) {
          if (item.text) parts.push(String(item.text))
        }
      }
      return parts.join('\n')
    },
    findOnScreen: async (needle, region) => {
      const argv = ['see', '--json', '--find', String(needle), '--scale', '2']
      if (region) argv.push('--region', region)
      const r = await runHandeye(argv, { timeoutMs: 30000 })
      const j = parseJsonLoose(r.stdout)
      return Boolean(j && Array.isArray(j.hits) && j.hits.length > 0)
    },
    runCommand,
    screenChanged: async () => {
      const r = await runHandeye(['see', '--json', '--changed'], { timeoutMs: 25000 })
      const j = parseJsonLoose(r.stdout)
      return Boolean(j && j.delta && j.delta.changed === true)
    },
  }

  function takeOverride(episodeId) {
    try {
      if (!existsSync(OVERRIDE_FILE)) return null
      const doc = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8'))
      if (!doc || String(doc.episodeId ?? '') !== String(episodeId ?? '')) return null
      unlinkSync(OVERRIDE_FILE) // 一次性：消费掉就没了
      return doc
    } catch {
      return null
    }
  }

  /** 进入目标的某一步：挂上这一步的验收、白名单，并开一个 episode。 */
  /**
   * 算出"这一步该验什么"。进步骤和结账都走这里 —— 结账时重算，
   * 是为了兜住"重启后 state 丢了、判据变空、步骤被静默标成完成"这个洞。
   */
  async function resolveStepChecks(step) {
    let checks = null
    let allowedTools = null
    if (step.promptId) {
      const card = await cards.get(String(step.promptId))
      if (card.ok) {
        allowedTools = Array.isArray(card.value.allowedTools) ? [...card.value.allowedTools] : null
        const norm = normalizeChecks(card.value.verify ?? [])
        checks = norm.ok ? (norm.checks.length > 0 ? norm.checks : null) : brokenChecks(norm.errors)
      }
    }
    if (Array.isArray(step.verify) && step.verify.length > 0) {
      const norm = normalizeChecks(step.verify)
      checks = norm.ok ? (norm.checks.length > 0 ? norm.checks : null) : brokenChecks(norm.errors)
    }
    return { checks, allowedTools }
  }

  /** 结账前重挂判据：state 可能因重启/换 episode 而空了。 */
  async function prepareStepChecks({ step }) {
    const { checks } = await resolveStepChecks(step)
    runtimeState.verifyChecks = checks
    return { checks: checks ? checks.length : 0 }
  }

  async function handleStepEnter({ goal, step, params }) {
    const { checks, allowedTools } = await resolveStepChecks(step)

    // 先开 episode（它会重置卡片相关字段），再挂目标步骤，顺序不能反
    const episodeId = await RUNTIME.startEpisode(`${goal.title} / ${step.title}`, {
      cardId: step.promptId || undefined,
      path: [step.title],
    })
    beginGoalStep(runtimeState, {
      goalId: goal.id,
      step: { ...step, allowedTools },
      verified: checks,
      params: params && typeof params === 'object' ? params : {},
    })
    return { episodeId, checks: checks ? checks.length : 0 }
  }

  /** 离开目标步骤：清掉步骤绑定，动作不再受这一步的白名单/预算约束。 */
  async function handleStepLeave({ reason } = {}) {
    endGoalStep(runtimeState)
    // 步骤结束就把这一步的 episode 收尾：之前只有“下一步开始时把上一步 superseded 掉”，
    // 于是最后一步的记录永远不会落盘（实测跑完三步，s3 那个 episode 在列表里找不到）。
    await flushActive(reason === 'verify-failed' ? 'failure' : 'success')
  }

  runtimeState.grantStepBudget = (extra) => grantStepBudget(runtimeState, extra)

  /** Called by episode_checkpoint before it advances the path. */
  async function verifyStep(state) {
    const checks = Array.isArray(state.verifyChecks) ? state.verifyChecks : null
    if (!checks || checks.length === 0) return { ok: true, checks: [], skipped: 'no-verify' }

    const override = takeOverride(state.episodeId)
    if (override) {
      return {
        ok: true,
        overridden: true,
        checks: [
          { type: 'override', target: '人工放行', ok: true, expected: '用户确认', actual: `用户放行：${override.reason || '未写原因'}`, ms: 0 },
        ],
      }
    }

    const vars = {
      ...(state.verifyVars || {}),
      intent: state.intent,
      episodeId: state.episodeId,
      cardId: state.cardId,
    }
    return runChecks(checks, vars, verifyDeps)
  }

  /** 卡片 → 运行时：挂上验收判据、步骤清单。 */
  async function applyCardToState(cardId) {
    if (!cardId) return
    try {
      const got = await cards.get(String(cardId))
      if (!got.ok) {
        RUNTIME?.logger?.warn?.(`applyCard: card "${cardId}" unavailable: ${got.message}`)
        return
      }
      const card = got.value
      const norm = normalizeChecks(card.verify ?? [])
      if (!norm.ok) {
        // 卡片判据写坏了：挂哨兵，宁可这一步验不过，也不能静静地把门打开
        runtimeState.verifyChecks = brokenChecks(norm.errors)
        runtimeState.cardId = card.id
        return
      }
      runtimeState.verifyChecks = norm.checks.length > 0 ? norm.checks : null
      runtimeState.cardId = card.id
      if (Array.isArray(card.path) && card.path.length > 0 && (runtimeState.path || []).length === 0) {
        runtimeState.path = card.path.map((s) => String(s)).slice(0, 12)
        runtimeState.pathIndex = 0
      }
      RUNTIME?.logger?.info?.(
        `applyCard: ${card.id} path=${(runtimeState.path || []).length} checks=${runtimeState.verifyChecks?.length ?? 0}`,
      )
    } catch (error) {
      RUNTIME?.logger?.warn?.(`applyCard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------ 感知（看）

  reg(ctx, {
    name: 'eye_see',
    description:
      'See what is on screen, projected for a text model. Returns L0 (one line: what this screen is and how many actionable entries), L1 (blocks + controls with coarse coordinates) or L2 (full raw observation). Alarm lines — dialogs, error words — are never downsampled at any level. Prefer this over screenshotting: it costs a fraction of the tokens. Use hand_click_text or desk_invoke to act on what it reports. OCR defaults to 2x upscale (much better on Chinese UI text); pass scale=1 only for speed.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['auto', 'L0', 'L1', 'L2'],
          description: 'Projection level. auto = L0 (cheapest). Use L1 to see block layout, L2 only when L1 is not enough.',
        },
        region: {
          type: 'string',
          description: 'Optional screen region "x,y,w,h" to scan instead of the whole screen.',
        },
        fast: { type: 'boolean', description: 'Use the fast OCR profile (lower quality, quicker).' },
        scale: {
          type: 'number',
          description: 'OCR upscale factor 1-4. Default 2 (2x makes small Chinese text readable); use 1 only when speed matters more than accuracy.',
        },
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const argv = ['see', '--json', args?.fast ? '--fast' : '--best']
        if (typeof args?.region === 'string' && args.region.trim()) argv.push('--region', args.region.trim())
        const scale = Number.isFinite(args?.scale) ? Math.min(4, Math.max(1, Math.round(args.scale))) : 2
        argv.push('--scale', String(scale))
        const view = await runHandeyeJson(argv, { timeoutMs: 55000 })
        const lines = project(view, args?.level || 'auto')
        return `${headline(view)}\n${lines.join('\n')}`
      } catch (e) {
        return fail('eye_see 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'eye_find',
    description:
      'Find text on screen (OCR based) and return its coordinates. For standard Windows controls prefer desk_find, which reads the real control tree instead of guessing from pixels.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to look for (case-insensitive substring match).' },
        max: { type: 'number', description: 'Maximum matches to return (default 8).' },
      },
      required: ['text'],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const q = String(args?.text ?? '').trim()
        if (!q) return 'eye_find 需要一个非空的 text'
        const view = await runHandeyeJson(['see', '--json', '--best', '--scale', '2'], { timeoutMs: 55000 })
        const lower = q.toLowerCase()
        const hits = []
        for (const b of view.blocks || []) {
          for (const it of b.items || []) {
            if (String(it.text || '').toLowerCase().includes(lower)) {
              hits.push({ text: it.text, x: it.x, y: it.y, w: it.w, h: it.h, kind: b.kind })
            }
          }
        }
        if (hits.length === 0) return `没找到「${q}」。可以换 eye_see level=L1 看看整屏，或者用 desk_find 查控件树。`
        const max = Number.isFinite(args?.max) ? Math.max(1, Math.floor(args.max)) : 8
        const lines = hits.slice(0, max).map((h) => `[${h.kind}] ${JSON.stringify(h.text)} @(${h.x},${h.y} ${h.w}x${h.h})`)
        const more = hits.length > max ? `\n（共 ${hits.length} 处，只列了前 ${max} 处）` : ''
        return lines.join('\n') + more
      } catch (e) {
        return fail('eye_find 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'eye_changed',
    description:
      'Cheaply check whether the screen changed since the last observation (image fingerprint, no OCR). Use it to wait for something to happen without paying for a full read.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        const view = await runHandeyeJson(['see', '--json', '--changed'], { timeoutMs: 25000 })
        const d = view.delta || {}
        if (d.changed === false) return '屏幕没有变化。'
        return `屏幕变了：新增 ${d.added ?? 0} 行、消失 ${d.removed ?? 0} 行。需要细节就用 eye_see。`
      } catch (e) {
        return fail('eye_changed 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'eye_shot',
    description:
      'Save a screenshot to a PNG file and return only its path. The image data does not enter the conversation, so several screenshots cost no context. Use it when you need the pixels (charts, canvas, a dialog you must look at) rather than text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute output path. Default: %TEMP%\\dsh-handeye-<timestamp>.png' },
      },
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target =
          typeof args?.path === 'string' && args.path.trim()
            ? args.path.trim()
            : `${process.env.TEMP || 'C:\\Windows\\Temp'}\\dsh-handeye-${stamp}.png`
        const r = await runHandeye(['see', '--save', target], { timeoutMs: 35000 })
        if (!r.ok) return fail('eye_shot 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
        return `截图已保存：${target}\n（图片本身没进对话；需要看图就把这个路径交给支持看图的模型或 modlens。）`
      } catch (e) {
        return fail('eye_shot 失败', e)
      }
    },
  })

  // ------------------------------------------------------------ 等待与区域细读

  reg(ctx, {
    name: 'eye_wait',
    description:
      'Wait for something to happen instead of sleeping and screenshotting in a loop. mode=appear blocks until the text shows up and returns its coordinates; mode=gone blocks until the text disappears (polls); mode=change blocks until the screen image changes at all. Always bounded by timeoutMs, so it cannot hang.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for (required for appear / gone).' },
        mode: { type: 'string', enum: ['appear', 'gone', 'change'], description: 'Default appear.' },
        timeoutMs: { type: 'number', description: 'Budget in milliseconds, default 8000, capped at 120000.' },
        fast: { type: 'boolean', description: 'Use the fast OCR profile. Default true (right for polling).' },
      },
    },
    timeoutMs: 150000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const mode = args?.mode === 'gone' || args?.mode === 'change' ? args.mode : 'appear'
      const budget = Math.min(120000, Math.max(200, Number.isFinite(args?.timeoutMs) ? args.timeoutMs : 8000))
      try {
        if (mode === 'change') {
          const r = await waitForChange({ timeoutMs: budget })
          if (r.changed) {
            const d = r.delta || {}
            return `屏幕变了（等了 ${r.elapsedMs}ms）：新增 ${d.added ?? 0} 行、消失 ${d.removed ?? 0} 行。需要细节就用 eye_see。`
          }
          return `屏幕在 ${budget}ms 内没有变化。` + (r.error === 'timeout' ? '（超时）' : '')
        }
        const text = String(args?.text ?? '').trim()
        if (!text) return `eye_wait mode=${mode} 需要 text`
        if (mode === 'gone') {
          const r = await waitForGone({ text, timeoutMs: budget, fast: args?.fast !== false })
          if (r.gone) return `「${text}」已经消失（等了 ${r.elapsedMs}ms）`
          const still = (r.hits || []).slice(0, 3).map((h) => `  ${JSON.stringify(h.text)} @(${h.x},${h.y})`).join('\n')
          return `等到 ${budget}ms 超时，「${text}」还在屏幕上${still ? '：\n' + still : ''}`
        }
        // appear 默认走慢档：它只跑一次，而快档读不出 9px 的小字
        const wait = await waitForText({ text, timeoutMs: budget, fast: args?.fast === true })
        return formatWaitResult(wait, { text, mode })
      } catch (e) {
        return fail('eye_wait 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'eye_region',
    description:
      'Crop one rectangle out of the screen, scale it up (default 3x) and save it as a PNG — that is how you read a small code, amount or timestamp without OCR guessing at 1x. Optionally also OCR just that rectangle. Returns the image path plus the exact region that was actually captured.',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'Rectangle "x,y,w,h" in screen coordinates (comma or space separated).' },
        scale: { type: 'number', description: 'Upscale factor 1-8, default 3.' },
        path: { type: 'string', description: 'Where to save the PNG. Default: %TEMP%\\dsh-handeye-region-<timestamp>.png' },
        text: { type: 'boolean', description: 'Also OCR the region and return its text.' },
      },
      required: ['region'],
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const rect = parseRegion(args?.region)
      if (!rect) return 'eye_region 需要 region="x,y,w,h"（宽高必须大于 0）'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const temp = process.env.TEMP || 'C:\\Windows\\Temp'
      const outPath =
        typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : `${temp}\\dsh-handeye-region-${stamp}.png`
      try {
        const scale = Number.isFinite(args?.scale) ? args.scale : 3
        let crop = null
        let via = 'GDI+ 直接抓屏'
        try {
          crop = await grabRegion({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale, outImage: outPath })
        } catch (grabError) {
          // 抓屏被拦（沙箱/DPR 异常）时退回 handeye 存全屏再裁
          const fullPath = `${temp}\\dsh-handeye-full-${stamp}.png`
          const shot = await runHandeye(['see', '--save', fullPath], { timeoutMs: 35000 })
          if (!shot.ok) {
            return fail('eye_region 失败', new Error(`抓屏和截图都失败了：${grabError.message} / ${shot.stderr.trim()}`))
          }
          crop = await cropRegion({ source: fullPath, x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale, outImage: outPath })
          via = 'handeye 截图后裁切'
        }
        const lines = [
          `区域截图已保存：${crop.image}（${via}）`,
          `实际截取：(${crop.region.x},${crop.region.y}) ${crop.region.w}x${crop.region.h}，放大 ${crop.scale} 倍 → ${crop.outW}x${crop.outH}`,
          '（需要看图就把这个路径交给支持看图的模型或 modlens。）',
        ]
        if (args?.text) {
          const ocr = await readRegion({ region: `${rect.x},${rect.y},${rect.w},${rect.h}`, scale: 4 })
          if (!ocr.ok) lines.push(`区域 OCR 失败：${ocr.error}`)
          else if (ocr.lines.length === 0) lines.push('区域 OCR：没有识别到文字。')
          else {
            lines.push('区域 OCR：')
            for (const l of ocr.lines.slice(0, 30)) lines.push(`  ${JSON.stringify(l.text)}`)
          }
        }
        return lines.join('\n')
      } catch (e) {
        return fail('eye_region 失败', e)
      }
    },
  })

  // ------------------------------------------------------------ 动作（手）

  reg(ctx, {
    name: 'hand_click',
    description:
      'Click at absolute screen coordinates with the real mouse. Pass hwnd (from desk_windows) or title to make it safe: focus, hit-test and click then happen inside one process, and the click is skipped entirely if the pixel turns out to belong to another window. The reply always names the window that was actually hit, so a misfire is visible instead of silent. Prefer hand_click_text (by text) or desk_invoke (by control) when you have a control name.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute X.' },
        y: { type: 'number', description: 'Absolute Y.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button, default left.' },
        hwnd: { type: 'number', description: 'Target window handle from desk_windows. Recommended: enables the wrong-window guard.' },
        title: {
          type: 'string',
          description: 'Or a window title fragment (exact beats prefix beats substring). Ignored when hwnd is given.',
        },
        doubleClick: { type: 'boolean', description: 'Double click instead of single click.' },
        dryRun: {
          type: 'boolean',
          description: 'Do the focus + hit-test but do not press the mouse. Use it to check a coordinate before trusting it.',
        },
      },
      required: ['x', 'y'],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const x = Number(args?.x)
      const y = Number(args?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'hand_click 需要数字 x 和 y'
      const target = resolveTarget(args)
      try {
        const json = await clickAt({
          x,
          y,
          button: args?.button === 'right' ? 'right' : 'left',
          doubleClick: !!args?.doubleClick,
          target,
          dryRun: !!args?.dryRun,
        })
        return formatClickResult(json)
      } catch (e) {
        if (e instanceof WinUiError) {
          if (e.code === 'wrong-window') {
            const wanted = e.extra?.wanted
            const actual = e.extra?.actual
            return [
              `失败：点击被拦下（没有按下鼠标）——(${Math.round(x)},${Math.round(y)}) 这个像素不属于目标窗口。`,
              wanted ? `目标：${describeWindow(wanted)}` : '',
              actual ? `实际：${describeWindow(actual)}` : '',
              '说明有别的东西压在目标上面（常见是 DSH 自己的窗口抢了前台）。',
              '可以重试一次；还不行就先 hand_focus 那个窗口，或者改用 hand_click_text / desk_invoke。',
            ]
              .filter(Boolean)
              .join('\n')
          }
          if (e.code === 'window-not-found') {
            let hint = ''
            try {
              const wins = await listTopWindows()
              const top = wins.slice(0, 8).map((w) => `  ${w.hwnd}  ${JSON.stringify(w.title || '')}`).join('\n')
              if (top) hint = `\n当前可见窗口：\n${top}`
            } catch { }
            return `失败：找不到目标窗口（${e.message}）${hint}`
          }
          return `失败：${e.message}${e.extra ? `（${JSON.stringify(e.extra).slice(0, 300)}）` : ''}`
        }
        return fail('hand_click 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'hand_click_text',
    description:
      'Find text on screen and click it (UI Automation first, OCR fallback). More robust than clicking coordinates. Add expect / expectGone to verify the action actually took effect instead of assuming.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text of the control or label to click.' },
        expect: { type: 'string', description: 'Optional text that must appear after the click.' },
        expectGone: { type: 'string', description: 'Optional text that must disappear after the click.' },
        right: { type: 'boolean', description: 'Right click instead of left click.' },
      },
      required: ['text'],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? '').trim()
      if (!text) return 'hand_click_text 需要一个非空的 text'
      const argv = ['click-text', text]
      if (typeof args?.expect === 'string' && args.expect.trim()) argv.push('--expect', args.expect.trim())
      if (typeof args?.expectGone === 'string' && args.expectGone.trim()) argv.push('--expect-gone', args.expectGone.trim())
      if (args?.right) argv.push('--right')
      const r = await runHandeye(argv, { timeoutMs: 40000 })
      if (r.ok) return `已点击「${text}」${r.stdout.trim() ? '\n' + r.stdout.trim() : ''}`
      return fail('hand_click_text 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
    },
  })

  reg(ctx, {
    name: 'hand_type',
    description:
      'Type text into the focused window (supports Chinese and any Unicode; does not touch the clipboard). Pass hwnd/title to focus that window first — keystrokes still go wherever focus ends up, so this narrows the race but cannot close it. To fill a known edit control with no race at all, prefer desk_set_value.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        hwnd: { type: 'number', description: 'Optional: focus this window handle first.' },
        title: { type: 'string', description: 'Optional: focus the window matching this title first.' },
      },
      required: ['text'],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? '')
      if (!text) return 'hand_type 需要一个非空的 text'
      const target = resolveTarget(args)
      let note = ''
      if (target) {
        try {
          const focused = await focusWindowTarget(target)
          note = `\n（已先切到 ${describeWindow(focused.window)}）`
        } catch (e) {
          return `失败：打字前切窗口没成功 — ${e.message}`
        }
      }
      const r = await runHandeye(['type', text], { timeoutMs: 25000 })
      return r.ok ? `已输入 ${[...text].length} 个字符${note}` : fail('hand_type 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
    },
  })

  reg(ctx, {
    name: 'hand_key',
    description:
      'Press a key or key combination, e.g. ENTER, TAB, ESC, CTRL+S, ALT+F4. Pass hwnd/title to focus that window first (same caveat as hand_type: the keystroke lands on whatever is in front at that instant).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combination.' },
        hwnd: { type: 'number', description: 'Optional: focus this window handle first.' },
        title: { type: 'string', description: 'Optional: focus the window matching this title first.' },
      },
      required: ['key'],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const key = String(args?.key ?? '').trim()
      if (!key) return 'hand_key 需要一个非空的 key'
      const target = resolveTarget(args)
      let note = ''
      if (target) {
        try {
          const focused = await focusWindowTarget(target)
          note = `\n（已先切到 ${describeWindow(focused.window)}）`
        } catch (e) {
          return `失败：按键前切窗口没成功 — ${e.message}`
        }
      }
      const r = await runHandeye(['key', key], { timeoutMs: 15000 })
      return r.ok ? `已按键 ${key}${note}` : fail('hand_key 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
    },
  })

  reg(ctx, {
    name: 'hand_focus',
    description:
      'Bring a window to the foreground by title fragment, then verify it actually got there. Exact titles beat prefixes beat substrings, and a minimized window is restored first. If Windows refuses the switch, it retries through the foreground thread input queue instead of silently reporting success.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title fragment.' },
        hwnd: { type: 'number', description: 'Or an exact window handle; skips title matching.' },
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = resolveTarget(args)
      if (!target) return 'hand_focus 需要 title 或 hwnd'
      try {
        const json = await focusWindowTarget(target)
        return formatFocusResult(json)
      } catch (e) {
        if (e instanceof WinUiError && e.code === 'window-not-found') {
          let hint = ''
          try {
            const wins = await listTopWindows()
            const match = target.title ? pickWindowByTitle(wins, target.title) : null
            const top = wins.slice(0, 8).map((w) => `  ${w.hwnd}  ${JSON.stringify(w.title || '')}`).join('\n')
            if (match) hint = `\n最接近的是：${describeWindow(match)}`
            if (top) hint += `\n当前可见窗口：\n${top}`
          } catch { }
          return `失败：${e.message}${hint}`
        }
        if (e instanceof WinUiError && e.code === 'focus-failed') {
          return `失败：窗口存在但没能拿到前台（${e.message}）。可以再试一次；如果是 UWP/全屏应用，Windows 不允许后台程序切它。`
        }
        // 老路：winui 后端不可用时退回 handeye focus
        const title = target.title || ''
        const r = await runHandeye(['focus', title], { timeoutMs: 15000 })
        return r.ok ? `已切到「${title}」（未做前台校验）` : fail('hand_focus 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'hand_where',
    description:
      'Ask which window owns a screen pixel right now, without clicking anything. Use it to check whether the window you think is in front really is in front — this is the cheapest way to catch a stolen foreground before a click goes astray.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute X.' },
        y: { type: 'number', description: 'Absolute Y.' },
      },
      required: ['x', 'y'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const x = Number(args?.x)
      const y = Number(args?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'hand_where 需要数字 x 和 y'
      try {
        const win = await windowAt(x, y)
        if (!win) return `(${Math.round(x)},${Math.round(y)}) 上没有窗口（桌面）。`
        return `(${Math.round(x)},${Math.round(y)}) 属于：${describeWindow(win)}`
      } catch (e) {
        return fail('hand_where 失败', e)
      }
    },
  })

  // ------------------------------------------------------------ 后台控件操作（不碰鼠标）

  reg(ctx, {
    name: 'desk_windows',
    description:
      'List open top-level windows with hwnd, pid, title, class and rect. Start here when you need to operate a program: every other desk_* tool takes an hwnd.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const wins = await listWindows()
        if (wins.length === 0) return '没有找到窗口。'
        const lines = wins.map(
          (w) =>
            `hwnd=${w.hwnd} pid=${w.pid} ${JSON.stringify(w.name || '')} class=${w.class || '-'} @(${w.x},${w.y} ${w.w}x${w.h})${w.offscreen ? ' [最小化/不可见]' : ''}`,
        )
        return lines.join('\n')
      } catch (e) {
        return fail('desk_windows 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_tree',
    description:
      'Read the UI Automation control tree of a window: every node gets a ref you can pass to desk_invoke / desk_set_value. This reads the real control structure, so it is exact and costs no tokens on pixels. Falls back to nothing for self-drawn apps (WeChat, Electron, Qt) — use hand_click_text there.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: 'Window handle from desk_windows.' },
        depth: { type: 'number', description: 'Tree depth, default 3.' },
        max: { type: 'number', description: 'Maximum nodes, default 400.' },
      },
      required: ['hwnd'],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const hwnd = Number(args?.hwnd)
        if (!Number.isFinite(hwnd)) return 'desk_tree 需要一个数字 hwnd'
        const nodes = await treeOf(hwnd, {
          depth: Number.isFinite(args?.depth) ? args.depth : 3,
          max: Number.isFinite(args?.max) ? args.max : 400,
        })
        const head = `窗口 ${hwnd} 共 ${nodes.length} 个节点（已过滤无名无动作的容器）：`
        const body = formatTree(nodes)
        // Chrome/Electron 默认不暴露页面无障碍树，只给窗口按钮。不说清楚的话，
        // 模型会以为"这个窗口没有控件"，然后白白换成截图乱猜。
        const chromiumHint =
          nodes.length <= 30
            ? '\n（如果这是 Chrome/Edge/Electron 窗口：它默认不导出页面控件的无障碍树，' +
              '所以看不到网页里的按钮和输入框。这种情况用 browser_attach 接管浏览器按 DOM 操作，' +
              '或者 hand_click 带 hwnd 安全点击坐标。）'
            : ''
        return head + '\n' + body + chromiumHint
      } catch (e) {
        return fail('desk_tree 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_find',
    description:
      'Find controls by name or automation id inside a window, and return their refs. This is the reliable way to locate a button or input box — exact match on the real control tree instead of OCR guessing.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: 'Window handle from desk_windows.' },
        query: { type: 'string', description: 'Name or automation id fragment (case-insensitive).' },
        depth: { type: 'number', description: 'Tree depth, default 5.' },
        max: { type: 'number', description: 'Maximum matches, default 10.' },
      },
      required: ['hwnd', 'query'],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const hwnd = Number(args?.hwnd)
        const q = String(args?.query ?? '').trim()
        if (!Number.isFinite(hwnd) || !q) return 'desk_find 需要数字 hwnd 和非空 query'
        const nodes = await treeOf(hwnd, { depth: Number.isFinite(args?.depth) ? args.depth : 5, max: 1200 })
        const hits = findControls(nodes, q)
        if (hits.length === 0) return `窗口 ${hwnd} 里没找到「${q}」。可以先用 desk_tree 看看有哪些控件。`
        const max = Number.isFinite(args?.max) ? Math.max(1, args.max) : 10
        const lines = hits.slice(0, max).map(
          (n) =>
            `${n.type} ${JSON.stringify(n.name || '')} ref=${n.ref} @(${n.x},${n.y} ${n.w}x${n.h})${n.patterns?.length ? ' [' + n.patterns.join(',') + ']' : ''}`,
        )
        return lines.join('\n') + (hits.length > max ? `\n（共 ${hits.length} 个，只列前 ${max} 个）` : '')
      } catch (e) {
        return fail('desk_find 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_invoke',
    description:
      'Activate a control by ref without moving the mouse and without raising its window: presses buttons, toggles checks, selects list items, expands menus. This is the preferred way to click in a standard Windows app.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Node ref from desk_tree / desk_find.' } },
      required: ['ref'],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const ref = String(args?.ref ?? '').trim()
      if (!ref) return 'desk_invoke 需要一个非空 ref'
      try {
        const r = await invokeRef(ref)
        return `已触发 ${ref}（方式 ${r.via}），鼠标没有移动。`
      } catch (e) {
        return fail('desk_invoke 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_set_value',
    description:
      'Write text into a control (edit box, combo) through ValuePattern: no keystrokes, no clipboard, no need for the window to be in front. This is the preferred way to fill a form field.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Node ref of the control.' },
        value: { type: 'string', description: 'Text to write.' },
      },
      required: ['ref', 'value'],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const ref = String(args?.ref ?? '').trim()
      if (!ref) return 'desk_set_value 需要一个非空 ref'
      try {
        const r = await setValueRef(ref, String(args?.value ?? ''))
        return `已写入 ${ref}（方式 ${r.via}），没有按键、没有占用剪贴板。`
      } catch (e) {
        return fail('desk_set_value 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_focus',
    description: 'Move keyboard focus to a control by ref (does not raise the window). Use it before typing into an app that needs real keystrokes.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Node ref.' } },
      required: ['ref'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const ref = String(args?.ref ?? '').trim()
      if (!ref) return 'desk_focus 需要一个非空 ref'
      try {
        await focusRef(ref)
        return `已聚焦 ${ref}`
      } catch (e) {
        return fail('desk_focus 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_text',
    description:
      'Read the text of a window straight from the control tree (exact strings, not OCR guesses). Much more accurate than eye_see for standard controls. Deduplicated and capped.',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: 'Window handle from desk_windows.' },
        max: { type: 'number', description: 'Maximum lines, default 200.' },
      },
      required: ['hwnd'],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const hwnd = Number(args?.hwnd)
        if (!Number.isFinite(hwnd)) return 'desk_text 需要一个数字 hwnd'
        const lines = await textOf(hwnd, { max: Number.isFinite(args?.max) ? args.max : 200 })
        if (lines.length === 0) return `窗口 ${hwnd} 没有可读文字（可能是自绘界面），改用 eye_see。`
        return lines.map((l) => `${JSON.stringify(l.text)}${l.ref ? ' ref=' + l.ref : ''}`).join('\n')
      } catch (e) {
        return fail('desk_text 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_launch',
    description: 'Launch a program, open a file or a URL, and return the pid.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Executable path, document path, or URL.' },
        args: { type: 'string', description: 'Optional argument string.' },
      },
      required: ['target'],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const target = String(args?.target ?? '').trim()
      if (!target) return 'desk_launch 需要一个非空 target'
      try {
        const r = await launchApp(target, typeof args?.args === 'string' ? args.args : '')
        return `已启动 ${target}（pid ${r.pid}）`
      } catch (e) {
        return fail('desk_launch 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'desk_batch',
    description:
      'Run 1 to 20 already-planned control actions in one PowerShell process: much faster than one call per step. Stops at the first failure and reports which step failed. Each action is {op:"invoke"|"setvalue"|"focus", ref, value?}.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Ordered actions.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['invoke', 'setvalue', 'focus'] },
              ref: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['op', 'ref'],
          },
        },
      },
      required: ['actions'],
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const actions = Array.isArray(args?.actions) ? args.actions : []
      if (actions.length === 0) return 'desk_batch 需要至少一个动作'
      if (actions.length > 20) return 'desk_batch 一次最多 20 个动作'
      try {
        const r = await batchActions(actions)
        const done = (r.steps || []).map((s) => `  ${s.step}. ${s.op} ok (${s.via})`).join('\n')
        if (r.ok) return `批量完成 ${actions.length} 步：\n${done}`
        return `批量在第 ${r.failed?.step} 步失败：${r.failed?.error}\n已完成：\n${done}`
      } catch (e) {
        return fail('desk_batch 失败', e)
      }
    },
  })

  // ------------------------------------------------------------ 浏览器（网页按元素操作）

  reg(ctx, {
    name: 'browser_attach',
    description:
      "Attach to the browser the user is already using instead of starting a throwaway one. That instance keeps the user's logins and cookies, so you can click a confirmation link without asking for a password. It only works if that browser was started with --remote-debugging-port; call this with no arguments to scan for one and get exact instructions if none is found. While attached, browser_stop will NOT close the user's browser, and browser_open opens a normal tab in it.",
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Specific debugging port to attach to. Omit to scan.' },
        detach: { type: 'boolean', description: 'Leave attached mode and go back to the throwaway instance.' },
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        if (args?.detach) {
          const r = detachBrowser()
          return `已断开接管，回到独立调试实例（端口 ${r.port}）。用户自己的浏览器没有被动过。`
        }
        const r = await attachBrowser({ port: args?.port })
        const tabs = (r.tabs || []).slice(0, 10)
        const lines = [
          `已接管用户的浏览器：端口 ${r.port}，${r.browser}（来源 ${r.source}）`,
          `标签页 ${r.tabs?.length ?? 0} 个：`,
          ...tabs.map((t) => `  ${t.id}  ${JSON.stringify(t.title)}  ${String(t.url || '').slice(0, 90)}`),
          '注意：这个模式下 browser_stop 不会关掉用户的浏览器。',
        ]
        return lines.join('\n')
      } catch (e) {
        let found = []
        try {
          found = await discoverEndpoints()
        } catch { }
        if (found.length > 0) {
          const list = found.map((f) => `  端口 ${f.port}（${f.browser}，来源 ${f.source}）`).join('\n')
          return [
            `接管失败：${e instanceof Error ? e.message : e}`,
            '但下面这些端口上有调试通道，直接指定 port 再试：',
            list,
          ].join('\n')
        }
        return [
          `没有找到带调试端口的浏览器：${e instanceof Error ? e.message : e}`,
          '用户的 Chrome/Edge 默认不带调试端口，所以现在只能接管不了。两个办法：',
          '1) 让用户彻底退出浏览器，再用下面这条命令重开（配置目录不变，登录态都还在）：',
          '   chrome.exe --remote-debugging-port=9222',
          '2) 或者继续用 browser_open 的独立实例（没有登录态）。',
        ].join('\n')
      }
    },
  })

  reg(ctx, {
    name: 'browser_open',
    description:
      'Open a URL in a dedicated browser instance (Edge or Chrome) driven by the DevTools protocol, and return a tabId. This instance uses its own profile and sits off-screen, so it never steals focus or your tabs — but it also does not carry your logins. Operate the page with browser_snapshot / browser_click / browser_fill, which work on real DOM elements instead of pixel guessing.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Address to open. Default about:blank.' },
        headless: { type: 'boolean', description: 'Launch headless if the browser is not running yet.' },
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        if (args?.headless) await ensureBrowser({ headless: true })
        const r = await openUrl(typeof args?.url === 'string' ? args.url : '')
        return `已在${isAttached() ? '用户自己的浏览器' : '调试浏览器'}打开：${r.url}\ntabId=${r.tabId}（端口 ${browserPort()}${isAttached() ? '，接管模式' : ''}）`
      } catch (e) {
        return fail('browser_open 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_snapshot',
    description:
      'List the interactive elements of a page (links, buttons, inputs, selects, role=button, contenteditable) with a stable index, label and position. Every element gets a data-dsh-eye index that browser_click and browser_fill accept. This is the reliable way to act on a web page — no coordinates, no OCR.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id from browser_open. Default: the most recent tab.' },
      },
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const s = await snapshot(args?.tabId)
        if (!s || !Array.isArray(s.items)) return '读不到页面结构'
        const head = `「${s.title}」 ${s.url}\n可交互元素 ${s.total} 个，列出 ${s.shown} 个：`
        const lines = s.items.map((it) => {
          const bits = [`#${it.i}`, it.tag]
          if (it.type) bits.push(it.type)
          if (it.label) bits.push(JSON.stringify(it.label))
          if (it.name) bits.push('name=' + it.name)
          if (it.href) bits.push('href=' + it.href.slice(0, 60))
          if (it.disabled) bits.push('disabled')
          return bits.join(' ')
        })
        return head + '\n' + lines.join('\n')
      } catch (e) {
        return fail('browser_snapshot 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_click',
    description:
      'Click an element by its snapshot index. Dispatches a real pointer/mouse/click sequence inside the page, so it works on React and Vue apps without moving your mouse.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'The #n index from browser_snapshot.' },
        tabId: { type: 'string', description: 'Tab id. Default: most recent tab.' },
      },
      required: ['index'],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const r = await clickIndex(args?.index, args?.tabId)
        if (!r?.ok) return `没点成：${r?.error || '未知原因'}`
        return `已点击 #${args.index} ${r.tag} ${JSON.stringify(r.label || '')}。页面可能已跳转，重新 browser_snapshot 再继续。`
      } catch (e) {
        return fail('browser_click 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_fill',
    description:
      'Type into an input/textarea by its snapshot index. Sets the value through the native setter and fires input+change events, so React/Vue state updates correctly. No keystrokes, no clipboard.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'The #n index from browser_snapshot.' },
        value: { type: 'string', description: 'Text to put in the field.' },
        tabId: { type: 'string', description: 'Tab id. Default: most recent tab.' },
      },
      required: ['index', 'value'],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const r = await fillIndex(args?.index, String(args?.value ?? ''), args?.tabId)
        if (!r?.ok) return `没写成：${r?.error || '未知原因'}`
        return `已向 #${args.index} 写入 ${[...String(args.value ?? '')].length} 个字符（当前值 ${JSON.stringify(r.value)}）`
      } catch (e) {
        return fail('browser_fill 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_text',
    description:
      'Read the visible text of the current page (title, url, body innerText), capped. Use it to read an article or the result of a search without OCR.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id. Default: most recent tab.' },
        maxChars: { type: 'number', description: 'Character cap, default 6000.' },
      },
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const r = await pageText(args?.tabId, Number.isFinite(args?.maxChars) ? args.maxChars : 6000)
        return `「${r.title}」 ${r.url}\n${r.text || '（页面没有可见文字）'}`
      } catch (e) {
        return fail('browser_text 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_navigate',
    description: 'Navigate an existing tab to a new URL (keeps the same tab, so history stays navigable inside the page).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Address to open.' },
        tabId: { type: 'string', description: 'Tab id. Default: most recent tab.' },
      },
      required: ['url'],
    },
    timeoutMs: 45000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const url = String(args?.url ?? '').trim()
      if (!url) return 'browser_navigate 需要一个非空 url'
      try {
        await navigate(url, args?.tabId)
        return `已跳转到 ${url}`
      } catch (e) {
        return fail('browser_navigate 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_tabs',
    description: 'List the tabs in the dedicated debugging browser.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const tabs = await listTabs()
        const mode = isAttached() ? `接管模式（端口 ${browserPort()}，用的是用户自己的浏览器）` : `独立实例（端口 ${browserPort()}）`
        if (tabs.length === 0) return `${mode}：没有标签页（先 browser_open）。`
        return `${mode}\n` + tabs.map((t) => `${t.id}  ${JSON.stringify(t.title)}  ${t.url.slice(0, 100)}`).join('\n')
      } catch (e) {
        return fail('browser_tabs 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_close',
    description: 'Close one tab of the dedicated debugging browser.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab id to close.' } },
      required: ['tabId'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = String(args?.tabId ?? '').trim()
      if (!id) return 'browser_close 需要一个非空 tabId'
      try {
        await closeTab(id)
        return `已关闭 ${id}`
      } catch (e) {
        return fail('browser_close 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'browser_stop',
    description:
      'Stop the dedicated debugging browser instance that browser_open started (the off-screen Edge/Chrome). It only touches that instance by its own profile directory, never your normal browser. Frees port 9333 for the next open.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        const r = await stopBrowser()
        if (r.attached) return '当前是接管模式，不会关掉用户自己的浏览器。要断开接管用 browser_attach detach=true。'
        return r.stopped ? '调试浏览器已关闭，端口已释放。' : '调试浏览器本来就没在跑。'
      } catch (e) {
        return fail('browser_stop 失败', e)
      }
    },
  })

  // ------------------------------------------------------------ 文字瘦身与账本
  reg(ctx, {
    name: 'eye_text',
    description:
      'Deterministic text slimming for documents: normalize, collapse repeated lines to (xN), drop pure separator noise, keep head and tail within a character budget. Error lines are never dropped. It projects, it never summarises or rewrites. Use it before pasting a long log or document into the conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Inline text to slim.' },
        path: { type: 'string', description: 'Or a file path to read and slim.' },
        budget: { type: 'number', description: 'Character budget, default 4000.' },
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        let input = typeof args?.text === 'string' ? args.text : ''
        if (!input && typeof args?.path === 'string' && args.path.trim()) {
          const { readFileSync } = await import('node:fs')
          input = readFileSync(args.path.trim(), 'utf8')
        }
        if (!input) return 'eye_text 需要 text 或 path'
        const r = slimText(input, { budget: Number.isFinite(args?.budget) ? args.budget : 4000 })
        const s = r.stats
        return `${r.text}\n\n--- stats: ${s.lines_in}→${s.lines_out} 行, ${s.chars_in}→${s.chars_out} 字符, 去重 ${s.deduped}, 去噪 ${s.noise}, 省略 ${s.omitted_lines} 行, 保留报警 ${s.alarms_kept} ---`
      } catch (e) {
        return fail('eye_text 失败', e)
      }
    },
  })

  reg(ctx, {
    name: 'yl_log',
    description:
      'Query the handeye system log (seven-field Windows-event-log style, with session and process tags). Use it to find out what actually happened: which clicks ran, which failed, why OCR gave nothing.',
    parameters: {
      type: 'object',
      properties: {
        tail: { type: 'number', description: 'How many recent events, default 30.' },
        level: { type: 'string', description: 'Minimum level: 严重/错误/警告/信息/详细 (or error/warn/info).' },
        id: { type: 'number', description: 'Filter by event id.' },
        grep: { type: 'string', description: 'Substring filter.' },
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const argv = ['log', '--json']
      argv.push('--tail', String(Number.isFinite(args?.tail) ? Math.max(1, Math.floor(args.tail)) : 30))
      if (typeof args?.level === 'string' && args.level.trim()) argv.push('--level', args.level.trim())
      if (Number.isFinite(args?.id)) argv.push('--id', String(Math.floor(args.id)))
      if (typeof args?.grep === 'string' && args.grep.trim()) argv.push('--grep', args.grep.trim())
      const r = await runHandeye(argv, { timeoutMs: 25000 })
      if (!r.ok) return fail('yl_log 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
      return r.stdout.trim() || '（没有匹配的日志）'
    },
  })

  // ------------------------------------------------------------ 记忆与能力
  const metaTools = createMetaTools({
    state: runtimeState,
    episodes,
    onBegin: async (info) => {
      startActiveEpisode(info)
      if (info?.cardId) await applyCardToState(info.cardId)
    },
    // 验收门：episode_checkpoint 推进前先调它
    verifyStep,
  })
  for (const def of metaTools) reg(ctx, def)

  // ------------------------------------------------------------ 目标（长期目标 / 分项步骤）
  const goalTools = createGoalTools({
    state: runtimeState,
    goals,
    skills,
    cards,
    verifyStep,
    prepareStepChecks,
    onStepEnter: handleStepEnter,
    onStepLeave: handleStepLeave,
  })
  for (const def of goalTools) reg(ctx, def)
  // 技能工具：读技能 -> 编译成目标；目标层负责门卫与验收
  for (const def of createSkillTools({ state: runtimeState, skills, goals })) reg(ctx, def)
  // 教程工具：用户手写的步骤 -> 编译成目标（和技能同一条执行通道）
  for (const def of createTutorialTools({ state: runtimeState, cards, goals })) reg(ctx, def)
  // 声音出口：播报完成/提醒（handeye say 不行会退到 System.Speech）
  for (const def of createVoiceTools({ runHandeye })) reg(ctx, def)

  reg(
    ctx,
    createCapabilityTool({
      state: runtimeState,
      store: capabilities,
      executor,
      confirm: confirmStore,
      episodes,
      getActiveEpisode: () => ACTIVE,
    }),
  )

  // 预置能力：只读默认启用，写操作默认禁用；同名能力不会被覆盖。
  try {
    const presetDir = fileURLToPath(new URL('../presets', import.meta.url))
    for (const file of readdirSync(presetDir)) {
      if (!file.endsWith('.json')) continue
      const doc = JSON.parse(readFileSync(path.join(presetDir, file), 'utf8'))
      void capabilities.installPreset(doc, { enabled: doc.risk === 'read' }).catch(() => {})
    }
  } catch (e) {
    ctx.logger?.warn?.(`preset install skipped: ${e instanceof Error ? e.message : e}`)
  }

  // 内置任务卡：只安装，不覆盖同名卡片。
  try {
    const promptDir = fileURLToPath(new URL('../prompts', import.meta.url))
    for (const file of readdirSync(promptDir)) {
      if (!file.endsWith('.json')) continue
      const doc = JSON.parse(readFileSync(path.join(promptDir, file), 'utf8'))
      void cards.installBuiltin(doc).catch(() => {})
    }
  } catch (e) {
    ctx.logger?.warn?.(`prompt install skipped: ${e instanceof Error ? e.message : e}`)
  }

  // ------------------------------------------------------------ 给界面用的活动路由
  //
  // 只读、同源、不带凭证。界面每隔两秒来问一次"刚才做了什么"。
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() =>
      sub.webServer.register({
        kind: 'exact',
        path: '/dsh-handeye/activity',
        handler: (req, res) => {
          const payload = JSON.stringify({
            ok: true,
            now: new Date().toISOString(),
            meta: { version: PKG.version, exe: exePath(), port: browserPort(), browserMode: browserMode() },
            items: ACTIVITY.slice(-120),
          })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
          })
          res.end(payload)
        },
      }),
    )
  })

  // 新面板用的只读/控制路由（日志、episode、能力、任务卡、暂停）。
  registerRoutes({ ctx, runtime: RUNTIME, version: PKG.version })

  // 启动时打一行，便于确认插件真的挂上了。
  try {
    ctx.logger?.info?.(`dsh-handeye 已加载，handeye = ${exePath()}`)
  } catch { }
}
