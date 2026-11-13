// 浏览器通道：用 Chrome/Edge 的调试协议（CDP）直接读写网页。
//
// 两种模式，区别很大，必须让调用方（和用户）一眼看清：
//   own      —— 我们自己起一个独立配置目录的浏览器，窗口放到屏幕外。
//               不碰用户的标签页、不抢焦点；但没有登录态。
//   attached —— 接管用户**正在用的**那个浏览器（它必须已经带着调试端口启动）。
//               有登录态、有 Cookie，适合"要点一封确认邮件里的链接"这类活。
//
// attached 模式有两条铁律：
//   - 绝不关闭用户的浏览器（stopBrowser 在 attached 下什么都不做）
//   - 绝不假装成功：端口没了就明确报错，而不是偷偷另起一个
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_PORT = Number(process.env.DSH_HANDEYE_CDP_PORT || 9333)
const PROFILE_DIR = process.env.DSH_HANDEYE_BROWSER_PROFILE || path.join(tmpdir(), 'dsh-handeye-browser')
const MAX_ELEMENTS = 120

// Ports that a browser with --remote-debugging-port is commonly started on.
export const COMMON_PORTS = [9333, 9222, 9223, 9224, 9225, 9515]

const CANDIDATES = [
  process.env.DSH_HANDEYE_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

let PORT = DEFAULT_PORT
let MODE = 'own' // 'own' | 'attached'
let launching = null

export function browserPort() {
  return PORT
}

/** 'own' = our throwaway instance, 'attached' = the user's own browser. */
export function browserMode() {
  return MODE
}

export function isAttached() {
  return MODE === 'attached'
}

function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      if (p && existsSync(p)) return p
    } catch { }
  }
  return null
}

function endpoint(pathname, port = PORT) {
  return `http://127.0.0.1:${port}${pathname}`
}

async function httpJson(url, { method = 'GET', timeoutMs = 5000 } = {}) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function browserStatus({ port = PORT } = {}) {
  try {
    const v = await httpJson(endpoint('/json/version', port), { timeoutMs: 1500 })
    return { running: true, port, webSocketDebuggerUrl: v.webSocketDebuggerUrl, browser: v.Browser }
  } catch {
    return { running: false, port }
  }
}

// ---------------------------------------------------------------- 端点发现（纯函数 + 探测）

/** Chrome/Edge 把实际端口写在这个文件里（只有 --remote-debugging-port=0 时才有）。 */
export function parseDevToolsActivePort(text) {
  const first = String(text ?? '').split(/\r?\n/, 1)[0].trim()
  const n = Number(first)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null
  return Math.trunc(n)
}

/** 从一堆命令行里抽出 --remote-debugging-port=N。 */
export function parseRemoteDebuggingPorts(commandLines) {
  const ports = []
  for (const line of Array.isArray(commandLines) ? commandLines : []) {
    const text = String(line ?? '')
    const re = /--remote-debugging-port[= ](\d{1,5})/gi
    let m
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1])
      if (n > 0 && n <= 65535) ports.push(n)
    }
  }
  return ports
}

/** 去重并保持顺序，丢掉非法值。 */
export function normalisePorts(values) {
  const seen = new Set()
  const out = []
  for (const v of Array.isArray(values) ? values : []) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
    const p = Math.trunc(n)
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function runProcessScan() {
  return new Promise((resolve) => {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|brave|vivaldi)\\.exe$' } | " +
      'ForEach-Object { $_.CommandLine }'
    let out = ''
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
      })
    } catch {
      resolve([])
      return
    }
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(out.split(/\r?\n/).filter(Boolean)))
    setTimeout(() => {
      try { child.kill() } catch { }
      resolve(out ? out.split(/\r?\n/).filter(Boolean) : [])
    }, 8000)
  })
}

function readActivePortFiles() {
  const base = process.env.LOCALAPPDATA || ''
  if (!base) return []
  const files = [
    path.join(base, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
    path.join(base, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'),
    path.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data', 'DevToolsActivePort'),
  ]
  const ports = []
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      const p = parseDevToolsActivePort(readFileSync(file, 'utf8'))
      if (p) ports.push(p)
    } catch { }
  }
  return ports
}

/**
 * 找一个「已经在跑、且带调试端口」的浏览器。
 * @returns {Promise<Array<{port:number,browser:string,source:string}>>}
 */
export async function discoverEndpoints({ extraPorts = [] } = {}) {
  const fromEnv = String(process.env.DSH_HANDEYE_ATTACH_PORT || '')
    .split(/[,\s]+/)
    .filter(Boolean)
  const candidates = []
  const push = (port, source) => {
    for (const p of normalisePorts([port])) candidates.push({ port: p, source })
  }

  for (const p of normalisePorts(fromEnv)) push(p, 'env')
  for (const p of normalisePorts(extraPorts)) push(p, 'argument')
  for (const p of readActivePortFiles()) push(p, 'DevToolsActivePort')
  for (const p of parseRemoteDebuggingPorts(await runProcessScan())) push(p, 'process')
  for (const p of COMMON_PORTS) push(p, 'scan')

  const seen = new Set()
  const found = []
  for (const c of candidates) {
    if (seen.has(c.port)) continue
    seen.add(c.port)
    const status = await browserStatus({ port: c.port })
    if (status.running) found.push({ port: c.port, browser: status.browser || 'unknown', source: c.source })
  }
  return found
}

/**
 * 接管用户正在用的浏览器。接管后所有 browser_* 都作用在它上面。
 * @returns {Promise<{port:number,browser:string,tabs:Array}>}
 */
export async function attachBrowser({ port } = {}) {
  const wanted = Number(port)
  let target = null
  if (Number.isFinite(wanted) && wanted > 0) {
    const status = await browserStatus({ port: wanted })
    if (!status.running) throw new Error(`no debugging channel on port ${wanted}`)
    target = { port: Math.trunc(wanted), browser: status.browser || 'unknown', source: 'argument' }
  } else {
    const all = await discoverEndpoints()
    // 优先接管「不是我们自己那个」的实例
    target = all.find((e) => e.port !== DEFAULT_PORT && e.source !== 'scan') || all[0] || null
  }
  if (!target) throw new Error('no browser with a debugging port found')

  MODE = 'attached'
  PORT = target.port
  tabs.clear()
  lastTabId = null
  const list = await listTabs()
  return { port: PORT, browser: target.browser, source: target.source, tabs: list }
}

/** 回到自己那个独立实例。不会碰用户浏览器。 */
export function detachBrowser() {
  MODE = 'own'
  PORT = DEFAULT_PORT
  tabs.clear()
  lastTabId = null
  return { port: PORT }
}

// ---------------------------------------------------------------- 启动 / 关闭

/** 确保有一个带调试端口的浏览器在跑；返回它的版本信息。 */
export async function ensureBrowser({ headless = false } = {}) {
  const now = await browserStatus()
  if (now.running) return now
  if (MODE === 'attached') {
    throw new Error(`the attached browser (port ${PORT}) is gone; it will not be restarted automatically - reopen it or use browser_attach`)
  }
  if (launching) return launching

  launching = (async () => {
    const exe = findBrowser()
    if (!exe) {
      throw new Error('Edge or Chrome not found (set DSH_HANDEYE_BROWSER to a path)')
    }
    mkdirSync(PROFILE_DIR, { recursive: true })
    const logPath = path.join(PROFILE_DIR, 'browser.log')
    let logFd = null
    try {
      logFd = openSync(logPath, 'a')
    } catch {
      logFd = null
    }
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,msEdgeIdentity',
      '--window-size=1280,900',
      // 放到屏幕外：看得见、但不会挡住你，也不会抢前台
      '--window-position=-32000,-32000',
      'about:blank',
    ]
    if (headless) args.push('--headless=new')
    const child = spawn(exe, args, {
      detached: true,
      // 把浏览器自己的 stdout/stderr 落盘，崩了能查原因；否则只能看到「连不上」
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      windowsHide: false,
    })
    child.unref()
    if (logFd !== null) {
      try { closeSync(logFd) } catch { }
    }

    const deadline = Date.now() + 20000
    for (;;) {
      await new Promise((r) => setTimeout(r, 400))
      const s = await browserStatus()
      if (s.running) {
        await closeJunkTabs()
        return s
      }
      if (Date.now() > deadline) {
        throw new Error(`the browser did not open debugging port ${PORT} within 20s (log: ${logPath})`)
      }
    }
  })()

  try {
    return await launching
  } finally {
    launching = null
  }
}

// 独立配置首次启动时，Edge 可能自作主张开一个同步确认页或欢迎页。
// 这些不是我们要的标签页，启动后立刻收掉，免得用户以为是我们开的。
const JUNK_TAB = /^(edge|chrome):\/\/(sync-confirmation|welcome|first-run|newtab)/i

async function closeJunkTabs() {
  try {
    const list = await httpJson(endpoint('/json/list'))
    if (!Array.isArray(list)) return
    for (const t of list) {
      if (t.type !== 'page') continue
      const url = String(t.url || '')
      if (!JUNK_TAB.test(url) && !/ntp\.msn/i.test(url)) continue
      try {
        await httpJson(endpoint(`/json/close/${t.id}`))
      } catch { }
      tabs.delete(t.id)
    }
  } catch { }
}

function killByProfile() {
  return new Promise((resolve) => {
    const psDir = PROFILE_DIR.replace(/'/g, "''")
    // 不按 exe 名字挑：Chrome 和 Edge 哪个都行，只认我们自己的配置目录。
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${psDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore' })
      child.on('close', resolve)
      child.on('error', resolve)
    } catch {
      resolve()
    }
  })
}

/** 关掉调试浏览器实例。attached 模式下**不动**用户的浏览器。 */
export async function stopBrowser() {
  if (MODE === 'attached') {
    tabs.clear()
    lastTabId = null
    return { stopped: false, attached: true }
  }
  const now = await browserStatus()
  if (!now.running) {
    tabs.clear()
    lastTabId = null
    return { stopped: false }
  }
  try {
    const v = await httpJson(endpoint('/json/version'), { timeoutMs: 1500 })
    if (v && v.webSocketDebuggerUrl) {
      const cdp = await new Cdp(v.webSocketDebuggerUrl).connect()
      cdp.send('Browser.close').catch(() => { })
    }
  } catch { }

  const deadline = Date.now() + 8000
  for (;;) {
    await new Promise((r) => setTimeout(r, 300))
    const s = await browserStatus()
    if (!s.running) break
    if (Date.now() > deadline) {
      await killByProfile()
      await new Promise((r) => setTimeout(r, 600))
      break
    }
  }
  tabs.clear()
  lastTabId = null
  return { stopped: true }
}

// ---------------------------------------------------------------- 极简 CDP 客户端

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.dead = false
    this.closedReason = ''
  }

  async connect(timeoutMs = 8000) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch { }
        reject(new Error(`cannot connect to the debugging channel ${this.wsUrl}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        this.ws = ws
        this.dead = false
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        this.dead = true
        reject(new Error('debugging channel error'))
      })
      // 页面被关掉、渲染进程崩溃、浏览器退出，都会走这里。
      // 之前没处理，缓存里留着一条死连接，之后每个动作都只会说「调试通道已断开」。
      ws.addEventListener('close', () => {
        this.dead = true
        this.closedReason = 'debugging channel closed (page or browser closed)'
        for (const [, entry] of this.pending) {
          entry.reject(new Error(this.closedReason))
        }
        this.pending.clear()
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
          else res(msg.result)
        }
      })
    })
    return this
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      if (this.dead || !this.ws || this.ws.readyState !== 1) {
        reject(new Error(this.closedReason || 'debugging channel closed'))
        return
      }
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }
      }, 30000)
    })
  }

  close() {
    try { this.ws?.close() } catch { }
  }
}

const tabs = new Map() // tabId -> { wsUrl, cdp }
let lastTabId = null // 最近一次由我们打开的标签页，作为默认目标

/** 让一个动作在连接刚断时能自愈一次，而不是直接报废。 */
async function withPage(fn) {
  try {
    return await fn()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!/debugging channel|websocket|ECONNRESET|gone/.test(message)) throw e
    // 缓存作废，重新从 /json/list 解析一次再试
    for (const entry of tabs.values()) {
      try { entry.cdp?.close() } catch { }
    }
    tabs.clear()
    return fn()
  }
}

async function listPages() {
  const list = await httpJson(endpoint('/json/list'))
  if (!Array.isArray(list)) throw new Error('cannot read the tab list (the browser may be closing)')
  return list.filter((t) => t.type === 'page')
}

async function pageCdp(tabId) {
  if (!tabId && lastTabId) tabId = lastTabId
  const pages = await listPages()
  if (pages.length === 0) throw new Error('no open tabs; call browser_open first')
  let target = null
  if (tabId) {
    target = pages.find((p) => p.id === tabId) || null
    if (!target) {
      throw new Error(`tab ${tabId} is gone (maybe closed). Use browser_tabs to see what is open.`)
    }
  } else {
    target = pages[pages.length - 1]
  }
  const key = target.id
  const existing = tabs.get(key)
  if (existing?.cdp && !existing.cdp.dead) return existing.cdp
  if (existing?.cdp?.dead) {
    try { existing.cdp.close() } catch { }
  }
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect()
  tabs.set(key, { wsUrl: target.webSocketDebuggerUrl, cdp })
  return cdp
}

async function evaluate(tabId, expression) {
  const run = async () => {
    const cdp = await pageCdp(tabId)
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'page script error')
    }
    return r.result?.value
  }
  return withPage(run)
}

function jsString(s) {
  return JSON.stringify(String(s))
}

// ---------------------------------------------------------------- 对外能力

export async function openUrl(url) {
  await ensureBrowser()
  const target = url && url.trim() ? url.trim() : 'about:blank'
  const created = await httpJson(endpoint(`/json/new?${encodeURIComponent(target)}`), { method: 'PUT' })
  const tab = created && created.id ? created : await httpJson(endpoint(`/json/new?${encodeURIComponent(target)}`))
  if (!tab || !tab.id) throw new Error('failed to open a new tab')
  tabs.set(tab.id, { wsUrl: tab.webSocketDebuggerUrl, cdp: null })
  lastTabId = tab.id
  return { tabId: tab.id, url: tab.url || target }
}

export async function navigate(url, tabId) {
  const encoded = jsString(url)
  await evaluate(tabId, `location.href = ${encoded}`)
  return url
}

const SNAPSHOT_JS = `(() => {
  const MAX = ${MAX_ELEMENTS};
  document.querySelectorAll('[data-dsh-eye]').forEach((e) => e.removeAttribute('data-dsh-eye'));
  const sel = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  };
  const els = [...document.querySelectorAll(sel)].filter(vis);
  const out = [];
  els.slice(0, MAX).forEach((el, i) => {
    const n = i + 1;
    el.setAttribute('data-dsh-eye', String(n));
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({
      i: n, tag,
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      label,
      href: el.getAttribute('href') || '',
      disabled: !!el.disabled,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  });
  return { title: document.title, url: location.href, total: els.length, shown: out.length, items: out };
})()`

export async function snapshot(tabId) {
  return evaluate(tabId, SNAPSHOT_JS)
}

export async function clickIndex(index, tabId) {
  const n = Number(index)
  if (!Number.isFinite(n)) throw new Error('click needs a numeric index')
  return evaluate(
    tabId,
    `(() => {
      const el = document.querySelector('[data-dsh-eye="${n}"]');
      if (!el) return { ok: false, error: 'this index is stale; run snapshot again' };
      if (el.disabled) return { ok: false, error: 'the control is disabled' };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return { ok: true, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || '').slice(0, 60) };
    })()`,
  )
}

export async function fillIndex(index, value, tabId) {
  const n = Number(index)
  if (!Number.isFinite(n)) throw new Error('fill needs a numeric index')
  const v = jsString(value)
  return evaluate(
    tabId,
    `(() => {
      const el = document.querySelector('[data-dsh-eye="${n}"]');
      if (!el) return { ok: false, error: 'this index is stale; run snapshot again' };
      if (el.disabled || el.readOnly) return { ok: false, error: 'the control is read-only' };
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ${v});
      else el.value = ${v};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value).slice(0, 60) };
    })()`,
  )
}

export async function pageText(tabId, maxChars = 6000) {
  const r = await evaluate(
    tabId,
    `(() => ({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n') }))()`,
  )
  const text = String(r?.text || '')
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n…(truncated; original ${text.length} chars)` : text
  return { title: r?.title || '', url: r?.url || '', text: clipped }
}

export async function listTabs() {
  const list = await httpJson(endpoint('/json/list'))
  if (!Array.isArray(list)) return []
  return list
    .filter((t) => t.type === 'page')
    .map((t) => ({ id: t.id, title: t.title, url: t.url }))
}

export async function closeTab(tabId) {
  const id = String(tabId)
  try {
    await httpJson(endpoint(`/json/close/${id}`))
  } catch { }
  tabs.delete(id)
  if (lastTabId === id) lastTabId = null
  return true
}
