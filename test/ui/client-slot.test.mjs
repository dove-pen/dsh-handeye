// 客户端插件的验收：把 client.js 放进假宿主里跑，不靠"看屏幕"。
//
// v0.33.0：注册方式照抄 dsh-context（"上下文"页签）——slots.inject('main') + key，
// 只占会话区；slots 不可用才退到右下角按钮 + 浮层。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(root + 'src/client.js', 'utf8')

function makeDom() {
  const nodes = new Map()
  const doc = {
    body: null,
    listeners: [],
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        style: { cssText: '' },
        children: [],
        attrs: {},
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
          this.attrs[name] = String(value)
        },
        getAttribute(name) {
          return this.attrs[name]
        },
      }
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

function loadClient({ react = true, slots = true } = {}) {
  const { doc, nodes } = makeDom()
  const registrations = []
  const injected = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (def) => {
          if (def.id !== 'dsh-handeye') throw new Error('wrong module id: ' + def.id)
          sandbox.__exports = def.factory((name) => {
            if (!react) throw new Error('no module: ' + name)
            if (name === 'react') return { createElement: (type, props) => ({ type, props }) }
            if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
            throw new Error('unexpected require: ' + name)
          })
        },
      },
      matchMedia: () => ({ matches: false }),
    },
    document: doc,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const ctx = {
    slots: slots
      ? {
          inject: (name, fn) => {
            injected.push(name)
            return fn()
          },
          register: (meta, component) => {
            registrations.push({ meta, component })
            return () => {}
          },
        }
      : undefined,
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  sandbox.__exports.apply(ctx)
  return { exports: sandbox.__exports, doc, nodes, registrations, injected }
}

test('the client is a DSH module with the right id', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
})

test('it registers on the main slot like dsh-context, with a key', () => {
  const { injected, registrations } = loadClient()
  assert.deepEqual(injected, ['main'], '挂 main 槽（上下文/编队同一个位置）')
  assert.equal(registrations.length, 1)
  const { meta } = registrations[0]
  assert.equal(meta.name, 'main')
  assert.equal(meta.key, 'dsh-handeye')
  assert.equal(typeof meta.locale, 'object')
})

test('the registered view is the dashboard iframe', () => {
  const { registrations } = loadClient()
  const element = registrations[0].component()
  const frame = element.props.children
  assert.equal(frame.type, 'iframe')
  assert.match(frame.props.src, /^\/dsh-handeye-plus\/dashboard/)
})

test('no floating button when the slot registration works', () => {
  const { nodes } = loadClient()
  assert.equal(nodes.get('dsh-handeye-btn'), undefined, '只占会话区，不该再多一个浮动按钮')
})

test('without slots it falls back to a floating button with a working overlay', () => {
  const { nodes } = loadClient({ slots: false })
  const btn = nodes.get('dsh-handeye-btn')
  assert.ok(btn, '兜底按钮应该出现')
  btn.onclick()
  const overlay = nodes.get('dsh-handeye-overlay')
  assert.ok(overlay)
  // 关闭按钮：独立的 ×，fixed 定位
  const close = nodes.get('dsh-handeye-close')
  assert.ok(close)
  assert.equal(close.textContent, '×')
  assert.match(close.style.cssText, /position:fixed/)
  close.onclick()
  assert.ok(!nodes.get('dsh-handeye-overlay'))
})

test('without react it degrades to the button instead of throwing', () => {
  const { nodes } = loadClient({ react: false })
  assert.ok(nodes.get('dsh-handeye-btn'), '没有 react 也要有入口')
})

test('the old tab registration shape is gone', () => {
  assert.doesNotMatch(source, /conversation\.view/)
  assert.doesNotMatch(source, /label: \(\) => 'HandEye'/)
})

test('a broken or empty host never throws', () => {
  const { exports } = loadClient()
  for (const ctx of [undefined, null, {}, { slots: null }, { slots: {} }]) {
    assert.doesNotThrow(() => exports.apply(ctx))
  }
})

test('the module-level load is guarded', () => {
  assert.match(source, /function loadEntry\(/)
  const sandbox = { window: {}, document: { body: null }, console }
  vm.createContext(sandbox)
  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'client.js' }))
})
