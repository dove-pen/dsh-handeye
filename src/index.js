// dsh-handeye 插件入口。
//
// 把三样东西收进一个插件：
//   1. handeye 的手（点、打、按键、切窗口）
//   2. 杨镜的看（L0/L1/L2 三级投影、报警永不降采样、文字瘦身、账本）
//   3. dsh-computer-use-win 的路数（UIA 后台按控件、批量动作、截图只给路径）
//
// 设计原则：能用后台控件就不用鼠标；能按名字就不用坐标；能投影就不喂原文。
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
  ensureBrowser,
  browserPort,
} from './browser.js'

export const name = 'dsh-handeye'
// cordis 要求显式声明依赖，否则 ctx.tools 取不到（会报 cannot get property "tools" without inject）。
export const inject = ['tools']

const ok = (s) => String(s ?? '')

// 每个工具都必须声明输出契约（schema + render），否则注册时直接报错。
// 我们的工具一律返回文本，所以统一一个声明就够了。
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

// 活动记录：给界面用的"刚才做了什么"。只放内存，最多 200 条，进程重启即清空。
// 这是给人看的，不是为了审计——真要审计去查 handeye 的七段日志（yl_log）。
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
  ACTIVITY.push({ t: new Date().toISOString(), tool, args: argText, ok, brief: clip(brief), ms })
  if (ACTIVITY.length > ACTIVITY_MAX) ACTIVITY.splice(0, ACTIVITY.length - ACTIVITY_MAX)
}

function reg(ctx, def) {
  const original = def.execute
  ctx.tools.register({
    output: TEXT_OUTPUT,
    ...def,
    async execute(args, exec) {
      const started = Date.now()
      try {
        const out = await original(args, exec)
        recordActivity(def.name, args, true, out, Date.now() - started)
        return out
      } catch (e) {
        recordActivity(def.name, args, false, e instanceof Error ? e.message : e, Date.now() - started)
        throw e
      }
    },
  })
}


function fail(prefix, err) {
  return `${prefix}：${err instanceof Error ? err.message : String(err)}`
}

export function apply(ctx) {
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

  // ------------------------------------------------------------ 动作（手）

  reg(ctx, {
    name: 'hand_click',
    description:
      'Click at absolute screen coordinates with the real mouse. Prefer hand_click_text (by text) or desk_invoke (by control) when possible: this one actually moves the pointer.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute X.' },
        y: { type: 'number', description: 'Absolute Y.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button, default left.' },
      },
      required: ['x', 'y'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const x = Number(args?.x)
      const y = Number(args?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'hand_click 需要数字 x 和 y'
      const argv = ['click', String(Math.round(x)), String(Math.round(y))]
      if (args?.button === 'right') argv.push('--right')
      const r = await runHandeye(argv, { timeoutMs: 15000 })
      return r.ok ? `已点击 (${Math.round(x)},${Math.round(y)})` : fail('hand_click 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
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
      'Type text into the focused window (supports Chinese and any Unicode; does not touch the clipboard). To fill a known edit control in the background, prefer desk_set_value.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type.' } },
      required: ['text'],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? '')
      if (!text) return 'hand_type 需要一个非空的 text'
      const r = await runHandeye(['type', text], { timeoutMs: 25000 })
      return r.ok ? `已输入 ${[...text].length} 个字符` : fail('hand_type 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
    },
  })

  reg(ctx, {
    name: 'hand_key',
    description: 'Press a key or key combination, e.g. ENTER, TAB, ESC, CTRL+S, ALT+F4.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name or combination.' } },
      required: ['key'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const key = String(args?.key ?? '').trim()
      if (!key) return 'hand_key 需要一个非空的 key'
      const r = await runHandeye(['key', key], { timeoutMs: 15000 })
      return r.ok ? `已按键 ${key}` : fail('hand_key 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
    },
  })

  reg(ctx, {
    name: 'hand_focus',
    description: 'Bring a window to the foreground by title fragment.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Window title fragment.' } },
      required: ['title'],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const title = String(args?.title ?? '').trim()
      if (!title) return 'hand_focus 需要一个非空的 title'
      const r = await runHandeye(['focus', title], { timeoutMs: 15000 })
      return r.ok ? `已切到「${title}」` : fail('hand_focus 失败', new Error(`${codeMeaning(r.code)} ${r.stderr.trim()}`))
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
        return `窗口 ${hwnd} 共 ${nodes.length} 个节点（已过滤无名无动作的容器）：\n${formatTree(nodes)}`
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
        return `已在调试浏览器打开：${r.url}\ntabId=${r.tabId}（端口 ${browserPort()}）`
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
        if (tabs.length === 0) return '调试浏览器里没有标签页（可能还没启动，先 browser_open）。'
        return tabs.map((t) => `${t.id}  ${JSON.stringify(t.title)}  ${t.url.slice(0, 100)}`).join('\n')
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
            items: ACTIVITY.slice(-60),
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

  // 启动时打一行，便于确认插件真的挂上了。
  try {
    ctx.logger?.info?.(`dsh-handeye 已加载，handeye = ${exePath()}`)
  } catch { }
}
