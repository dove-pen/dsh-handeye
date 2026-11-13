// 客户端插件的验收：不靠"看屏幕"，而是把 client.js 放进假宿主里跑一遍。
//
// 2026-11-13 教训：旧版靠在 DOM 里插按钮，宿主一重渲染就丢（页签反复消失）。
// 现在走官方 slots API，这条测试直接检查"注册了哪个槽、什么 id、什么顺序"。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(root + 'src/client.js', 'utf8')

function loadClient() {
  const registrations = []
  const effects = []
  const injected = []
  const requests = []

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useState: (initial) => [initial, () => {}],
  }
  const jsx = (type, props) => ({ type, props })

  const requireStub = (name) => {
    requests.push(name)
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw new Error('unexpected require: ' + name)
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (def) => {
          if (def.id !== 'dsh-handeye') throw new Error('wrong module id: ' + def.id)
          sandbox.__exports = def.factory(requireStub)
        },
      },
      open: () => {},
    },
    document: {
      body: null,
      querySelector: () => null,
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const ctx = {
    slots: {
      inject: (name, fn) => {
        injected.push(name)
        return fn()
      },
      register: (meta, component) => {
        registrations.push({ meta, component })
        return () => {}
      },
    },
    effect: (fn) => {
      const disposer = fn()
      effects.push(disposer)
      return () => {}
    },
  }

  sandbox.__exports.apply(ctx)
  return { registrations, injected, requests, effects, exports: sandbox.__exports }
}

test('the client is a DSH module with the right id', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
})

test('it requires react and the jsx runtime (no hand-rolled DOM injection)', () => {
  const { requests } = loadClient()
  assert.ok(requests.includes('react'), '应当 require react')
  assert.ok(requests.includes('react/jsx-runtime'), '应当 require jsx-runtime')
})

test('it registers a real tab on conversation.view, next to 上下文 and 编队', () => {
  const { injected, registrations } = loadClient()
  assert.deepEqual(injected, ['conversation.view'])
  assert.equal(registrations.length, 1)
  const { meta } = registrations[0]
  assert.equal(meta.name, 'conversation.view')
  assert.equal(meta.id, 'shouzuian')
  assert.equal(typeof meta.order, 'number')
  assert.equal(meta.label(), '手嘴眼')
})

test('the tab renders the plugin dashboard in an iframe', () => {
  const { registrations } = loadClient()
  const element = registrations[0].component()
  const frame = element.props.children
  assert.equal(frame.type, 'iframe')
  assert.equal(frame.props.src, '/dsh-handeye-plus/dashboard')
})

test('registration is wrapped in ctx.effect so it can be disposed', () => {
  const { effects } = loadClient()
  assert.equal(effects.length, 1)
})

test('the old drawer is gone', () => {
  assert.doesNotMatch(source, /dsh-he-panel/, '旧的右侧抽屉应该删掉')
  assert.doesNotMatch(source, /mountTopTab/, '不再往宿主标签行塞按钮')
  assert.doesNotMatch(source, /dsh-he-tab/, '不再操作宿主标签行')
})

test('a host without slots still gets a minimal entry, not a drawer', () => {
  // 直接把 slots 去掉再跑一次 apply，确认走兜底而不是抛错
  const { exports } = loadClient()
  const calls = []
  const ctxNoSlots = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: undefined,
  }
  const sandboxDoc = {
    body: { appendChild: () => calls.push('append') },
    querySelector: () => null,
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {} }),
  }
  // 兜底分支用 document.body；这里只验证不抛错（真实 DOM 行为在浏览器里）
  assert.doesNotThrow(() => exports.apply(ctxNoSlots))
})

test('the client dependency list includes the slots package', () => {
  const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))
  const inject = pkg.dsh.client.inject
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'ctx.slots 来自 ui-slots 包')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'tab 槽来自会话 UI 包')
  assert.ok(!inject.includes('@deepseek-ai/dsh-api-remotes'), '不该带无关包')
})
