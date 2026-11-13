// dsh-handeye — client half（对外叫「手嘴眼」）。
//
// 一条铁律：**客户端插件绝不能把宿主搞挂**。
// 2026-11-13 重启后出过故障（用户不得不禁用全部第三方插件），所以这一版全部包在
// try/catch 里：拿不到 React、slots 形状不对、登记抛错 —— 都只让本插件的入口消失，
// 不影响 DSH 本身。
//
// 入口走官方 slots（和 dsh-context 的"上下文"、编队的注册方式一致）：
//   ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, Panel))

// 加载层包一层：插件入口一旦抛错，宿主会把它算成 "web boot: entry did not activate"，
// 而**这个错误是致命的** —— 2026-11-13 实测：DSH 直接起不来，用户只能禁用所有第三方插件。
function loadEntry(definition) {
  try {
    if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
      console.warn('[handeye] ModuleLoader is unavailable; skipping the client entry')
      return
    }
    window.__ModuleLoader__.load(definition)
  } catch (error) {
    console.warn('[handeye] client entry failed to load (ignored): ' + (error instanceof Error ? error.message : String(error)))
  }
}

loadEntry({
  id: 'dsh-handeye',
  factory: (require) => {
    const PANEL_URL = '/dsh-handeye-plus/dashboard'

    let React = null
    let jsx = null
    try {
      React = require('react')
      jsx = require('react/jsx-runtime').jsx
    } catch {
      // 拿不到 React 也不抛：退到"新窗口打开面板"的兜底入口
    }

    function Panel() {
      if (!jsx) return null
      // 填满页签区域；高度交给宿主布局
      return jsx('div', {
        style: { height: '100%', width: '100%', display: 'flex', minHeight: 0 },
        children: jsx('iframe', {
          src: PANEL_URL,
          title: 'HandEye Control Panel',
          style: { flex: 1, width: '100%', border: 0, minHeight: 0, background: '#0f1115' },
        }),
      })
    }

    function registerTab(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error('slots API is unavailable')
      }
      const register = () =>
        slots.inject('conversation.view', () =>
          slots.register(
            { name: 'conversation.view', id: 'shouzuian', order: 25, label: () => 'HandEye' },
            Panel,
          ),
        )
      // 有 effect 就交给它管生命周期；没有就直接登记（活着总比没有强）
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-handeye: conversation tab')
      else register()
    }

    // 兜底：slots 用不了时，只放一个极小的按钮（不重建旧抽屉）
    function fallbackEntry() {
      if (typeof document === 'undefined' || !document.body) return
      if (document.querySelector('[data-dsh-he-fallback]')) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.dshHeFallback = '1'
      btn.textContent = 'HandEye'
      btn.style.cssText =
        'position:fixed;right:16px;top:52px;z-index:2147483000;font:inherit;font-size:12px;color:#e6e9ee;' +
        'background:#1c2129;border:1px solid #262c36;border-radius:6px;padding:4px 10px;cursor:pointer'
      btn.onclick = () => window.open(PANEL_URL, 'shouzuian-panel', 'width=1440,height=900')
      document.body.appendChild(btn)
    }

    function apply(ctx) {
      let registered = false
      try {
        registerTab(ctx)
        registered = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          ctx?.logger?.warn?.('handeye tab registration skipped: ' + message)
        } catch {}
        console.warn('[handeye] tab registration failed; using the fallback entry: ' + message)
      }
      if (!registered) {
        try {
          fallbackEntry()
        } catch {}
      }
    }

    return { apply }
  },
})
