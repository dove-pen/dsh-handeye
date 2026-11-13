// 客户端插件的验收：不靠"看屏幕"，而是把 client.js 放进假 DOM 里跑一遍。
//
// 2026-11-13 两次教训：
//   1. 在宿主标签行里插按钮 → 宿主一重渲染就丢
//   2. 走 conversation.view 页签 → 按钮出现但点了不切换（slots 契约没文档）
// 现在改成：自己画一个浮层（按钮 + iframe），纯 DOM，一定能用。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(root + 'src/client.js', 'utf8')

/** 极简 DOM：够 client.js 用（createElement/append/remove/getElementById）。 */
function makeDom() {
  const nodes = new Map()
  const doc = {
    body: null,
    listeners: [],
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        style: { cssText: '' },
        children: [],
        id: '',
        type: '',
        textContent: '',
        title: '',
        append(...kids) {
          for (const kid of kids) this.appendChild(kid)
        },
        appendChild(kid) {
          this.children.push(kid)
          if (kid.id) nodes.set(kid.id, kid)
          return kid
        },
        remove() {
          if (this.id) nodes.delete(this.id)
          doc.body.children = doc.body.children.filter((c) => c !== this)
        },
        setAttribute(name, value) {
          this.attrs = { ...(this.attrs || {}), [name]: String(value) }
        },
        getAttribute(name) {
          return this.attrs ? this.attrs[name] : undefined
        },
      }
      return el
    },
    getElementById: (id) => nodes.get(id) || null,
    querySelector: () => null,
    addEventListener: (type, fn) => doc.listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      doc.listeners = doc.listeners.filter((l) => !(l.type === type && l.fn === fn))
    },
  }
  doc.body = doc.createElement('body')
  doc.body.children = []
  return { doc, nodes }
}

function loadClient() {
  const { doc, nodes } = makeDom()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (def) => {
          if (def.id !== 'dsh-handeye') throw new Error('wrong module id: ' + def.id)
          sandbox.__exports = def.factory(() => {
            throw new Error('client must not require anything')
          })
        },
      },
      open: () => {},
    },
    document: doc,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return { exports: sandbox.__exports, doc, nodes }
}

test('the client is a DSH module with the right id', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
})

test('apply mounts a floating HandEye button', () => {
  const { exports, nodes } = loadClient()
  exports.apply({})
  const btn = nodes.get('dsh-handeye-btn')
  assert.ok(btn, '按钮应该挂到 body 上')
  assert.equal(btn.textContent, 'HandEye')
  assert.match(btn.style.cssText, /position:fixed/)
})

test('clicking the button opens a full-screen overlay with the dashboard iframe', () => {
  const { exports, nodes, doc } = loadClient()
  exports.apply({})
  const btn = nodes.get('dsh-handeye-btn')
  btn.onclick()

  const overlay = nodes.get('dsh-handeye-overlay')
  assert.ok(overlay, '点一下应该出现浮层')
  assert.match(overlay.style.cssText, /position:fixed/)
  assert.match(overlay.style.cssText, /inset:0/)

  const frame = overlay.children.find((c) => c.tagName === 'IFRAME')
  assert.ok(frame, '浮层里应该有 iframe')
  assert.match(frame.src, /^\/dsh-handeye-plus\/dashboard/)

  // 同一个按钮再点一次不应该叠出第二层
  btn.onclick()
  assert.equal(doc.body.children.filter((c) => c.id === 'dsh-handeye-overlay').length, 1)
})

test('the overlay can be closed by the button and by Esc', () => {
  const { exports, nodes, doc } = loadClient()
  exports.apply({})
  nodes.get('dsh-handeye-btn').onclick()
  assert.ok(nodes.get('dsh-handeye-overlay'))

  // 关闭按钮现在是独立的 ×（fixed 定位，不受顶栏布局影响）
  const close = nodes.get('dsh-handeye-close')
  assert.ok(close, '必须有一个关闭按钮')
  assert.equal(close.textContent, '×')
  assert.match(close.style.cssText, /position:fixed/)
  close.onclick()
  assert.ok(!nodes.get('dsh-handeye-overlay'))

  // Esc
  nodes.get('dsh-handeye-btn').onclick()
  const esc = doc.listeners.find((l) => l.type === 'keydown')
  esc.fn({ key: 'Escape' })
  assert.ok(!nodes.get('dsh-handeye-overlay'))
})

test('the old slot registration and tab injection are gone', () => {
  assert.doesNotMatch(source, /slots\.inject\(/, '不再赌未文档化的页签契约')
  assert.doesNotMatch(source, /slots\.register/, '不再调用 slots')
  assert.doesNotMatch(source, /dsh-he-panel/, '旧抽屉已删')
  assert.doesNotMatch(source, /mountTopTab/, '不再往宿主标签行塞按钮')
})

test('a broken or empty host never throws', () => {
  const { exports } = loadClient()
  const broken = [undefined, null, {}, { slots: null }, { body: null }]
  for (const ctx of broken) assert.doesNotThrow(() => exports.apply(ctx))
})

test('the module-level load is guarded', () => {
  // 2026-11-13 事故：入口抛错 → "web boot: 1 entry did not activate" → 整个 DSH 起不来。
  assert.match(source, /function loadEntry\(/)
  assert.match(source, /window\.__ModuleLoader__\.load\(definition\)/)
  const sandbox = { window: {}, document: { body: null }, console }
  vm.createContext(sandbox)
  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'client.js' }))
})

test('a host without __ModuleLoader__ is skipped quietly', () => {
  const sandbox = { window: {}, document: { body: null }, console }
  vm.createContext(sandbox)
  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'client.js' }))
})

test('package.json no longer needs the client slot packages', () => {
  const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-ui-slots'), '不再需要 ui-slots')
})

test('the close button is explicit and reachable', () => {
  const { exports, nodes } = loadClient()
  exports.apply({})
  nodes.get('dsh-handeye-btn').onclick()
  const close = nodes.get('dsh-handeye-close')
  assert.equal(close.getAttribute('aria-label'), 'Close panel')
  assert.match(close.title, /Close panel/)
  // 提示文字不再写死 "Close" 这个词
  const overlay = nodes.get('dsh-handeye-overlay')
  const bar = overlay.children[0]
  assert.ok(bar.children.some((c) => /press Esc/.test(c.textContent)), '顶栏应提示 Esc')
})
