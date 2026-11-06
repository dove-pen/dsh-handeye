// 浏览器通道：用 Chrome/Edge 的调试协议（CDP）直接读写网页。
//
// 为什么不用鼠标点网页：网页元素有结构，按元素操作既准又不用抢前台。
// 为什么不复用用户正在用的浏览器：那会把标签页、登录态、焦点全搅在一起。
// 所以这里起一个**独立配置目录**的浏览器实例，窗口放在屏幕外，互不打扰。
//
// 代价要说清楚：独立配置 = 没有你的登录态。需要登录的站点请自己先在那个窗口
// 里登一次，或者改用 hand_* 走你现成的浏览器。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.DSH_HANDEYE_CDP_PORT || 9333)
const PROFILE_DIR = process.env.DSH_HANDEYE_BROWSER_PROFILE || path.join(tmpdir(), 'dsh-handeye-browser')
const MAX_ELEMENTS = 120

const CANDIDATES = [
  process.env.DSH_HANDEYE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

let launching = null

function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      if (p && existsSync(p)) return p
    } catch { }
  }
  return null
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

export async function browserStatus() {
  try {
    const v = await httpJson(`http://127.0.0.1:${PORT}/json/version`, { timeoutMs: 1500 })
    return { running: true, webSocketDebuggerUrl: v.webSocketDebuggerUrl, browser: v.Browser }
  } catch {
    return { running: false }
  }
}

/** 确保有一个带调试端口的浏览器在跑；返回它的版本信息。 */
export async function ensureBrowser({ headless = false } = {}) {
  const now = await browserStatus()
  if (now.running) return now
  if (launching) return launching

  launching = (async () => {
    const exe = findBrowser()
    if (!exe) {
      throw new Error('找不到 Edge 或 Chrome（可用环境变量 DSH_HANDEYE_BROWSER 指定路径）')
    }
    mkdirSync(PROFILE_DIR, { recursive: true })
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1280,900',
      // 放到屏幕外：看得见、但不会挡住你，也不会抢前台
      '--window-position=-32000,-32000',
    ]
    if (headless) args.push('--headless=new')
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()

    const deadline = Date.now() + 20000
    for (;;) {
      await new Promise((r) => setTimeout(r, 400))
      const s = await browserStatus()
      if (s.running) return s
      if (Date.now() > deadline) throw new Error(`浏览器在 20 秒内没有打开调试端口 ${PORT}`)
    }
  })()

  try {
    return await launching
  } finally {
    launching = null
  }
}

// ---------------------------------------------------------------- 极简 CDP 客户端

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
  }

  async connect(timeoutMs = 8000) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch { }
        reject(new Error(`连不上调试通道 ${this.wsUrl}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.addEventListener('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`调试通道出错：${e?.message || 'unknown'}`))
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
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('调试通道已断开'))
        return
      }
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} 超时`))
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

async function pageCdp(tabId) {
  if (!tabId && lastTabId) tabId = lastTabId
  if (tabId && tabs.has(tabId)) {
    const entry = tabs.get(tabId)
    if (!entry.cdp) entry.cdp = await new Cdp(entry.wsUrl).connect()
    return entry.cdp
  }
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`)
  if (!Array.isArray(list)) throw new Error('读不到标签页列表')
  const pages = list.filter((t) => t.type === 'page')
  if (pages.length === 0) throw new Error('没有打开的标签页，先 browser_open')
  const target = tabId ? pages.find((p) => p.id === tabId) : pages[pages.length - 1]
  if (!target) throw new Error(`找不到标签页 ${tabId}`)
  const key = target.id
  if (!tabs.has(key)) tabs.set(key, { wsUrl: target.webSocketDebuggerUrl, cdp: null })
  const entry = tabs.get(key)
  if (!entry.cdp) entry.cdp = await new Cdp(entry.wsUrl).connect()
  return entry.cdp
}

async function evaluate(tabId, expression) {
  const cdp = await pageCdp(tabId)
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || '页面脚本报错')
  }
  return r.result?.value
}

function jsString(s) {
  return JSON.stringify(String(s))
}

// ---------------------------------------------------------------- 对外能力

export async function openUrl(url) {
  await ensureBrowser()
  const target = url && url.trim() ? url.trim() : 'about:blank'
  const created = await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' })
  if (!created || !created.id) {
    // 某些版本用 GET；再试一次
    const again = await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(target)}`)
    if (!again || !again.id) throw new Error('新建标签页失败')
    tabs.set(again.id, { wsUrl: again.webSocketDebuggerUrl, cdp: null })
    lastTabId = again.id
    return { tabId: again.id, url: again.url || target }
  }
  tabs.set(created.id, { wsUrl: created.webSocketDebuggerUrl, cdp: null })
  lastTabId = created.id
  return { tabId: created.id, url: created.url || target }
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
  if (!Number.isFinite(n)) throw new Error('click 需要数字 index')
  return evaluate(
    tabId,
    `(() => {
      const el = document.querySelector('[data-dsh-eye="${n}"]');
      if (!el) return { ok: false, error: '这个序号已经失效，先重新 snapshot' };
      if (el.disabled) return { ok: false, error: '控件是 disabled 状态' };
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
  if (!Number.isFinite(n)) throw new Error('fill 需要数字 index')
  const v = jsString(value)
  return evaluate(
    tabId,
    `(() => {
      const el = document.querySelector('[data-dsh-eye="${n}"]');
      if (!el) return { ok: false, error: '这个序号已经失效，先重新 snapshot' };
      if (el.disabled || el.readOnly) return { ok: false, error: '控件不可写' };
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
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n…（截断，原文 ${text.length} 字符）` : text
  return { title: r?.title || '', url: r?.url || '', text: clipped }
}

export async function listTabs() {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`)
  if (!Array.isArray(list)) return []
  return list
    .filter((t) => t.type === 'page')
    .map((t) => ({ id: t.id, title: t.title, url: t.url }))
}

export async function closeTab(tabId) {
  const id = String(tabId)
  try {
    await httpJson(`http://127.0.0.1:${PORT}/json/close/${id}`)
  } catch { }
  tabs.delete(id)
  if (lastTabId === id) lastTabId = null
  return true
}

export function browserPort() {
  return PORT
}
