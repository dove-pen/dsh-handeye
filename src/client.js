// dsh-handeye — client half（对外叫「HandEye / 手嘴眼」）。
//
// 铁律：客户端插件绝不能把宿主搞挂。所有东西包在 try/catch 里。
//
// 2026-11-13 找到根因（DSH 插件文档就在 app.asar 里）：
//   return { inject: ['slots'], apply(ctx) { ctx.slots.inject(slot, () => ctx.slots.register(meta, C)) } }
// **少了 inject: ['slots']，ctx.slots 就是 undefined** —— 注册永远抛错，
// 用户看到的"HandEye 按钮"其实是兜底按钮，不是页签。之前 v0.22~v0.33 全部症状由此而来。
//
// v0.34.0：
//   1. 模块导出 { inject: ['slots'], apply }
//   2. 注册 conversation.view（页签，和 对话/轨迹/上下文/编队 并列）→ 只占会话区
//   3. 同时注册 main 槽（dsh-context 的"上下文"用的就是它）
//   4. 兜底按钮只在注册失败时出现；浮层带一个**大号 Close 按钮**（不再是隐蔽的小 ×）

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
    const BTN_ID = 'dsh-handeye-btn'
    const OVERLAY_ID = 'dsh-handeye-overlay'
    const CLOSE_ID = 'dsh-handeye-close'

    let jsx = null
    try {
      jsx = require('react/jsx-runtime').jsx
    } catch {
      jsx = null
    }

    function Panel() {
      if (!jsx) return null
      return jsx('div', {
        style: { height: '100%', width: '100%', display: 'flex', minHeight: 0 },
        children: jsx('iframe', {
          src: PANEL_URL + '?embed=1',
          title: 'HandEye Control Panel',
          style: { flex: 1, width: '100%', border: 0, minHeight: 0, background: '#0b0d11' },
        }),
      })
    }

    /** 注册两个位置：页签（会话区）+ main（上下文那种大视图）。 */
    function registerSlots(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error('slots API is unavailable')
      }
      if (!jsx) throw new Error('react is unavailable')
      // meta.locale 要的是**命名空间字符串**（dsh-context 传的是 'dsh-context'），
      // 不是 locale 服务对象 —— 读服务还会要求额外 inject，一读就抛。
      const locale = 'dsh-handeye'

      const registerTab = () =>
        slots.inject('conversation.view', () =>
          slots.register(
            { name: 'conversation.view', id: 'handeye', order: 25, label: () => 'HandEye', locale },
            Panel,
          ),
        )
      const registerMain = () =>
        slots.inject('main', () => slots.register({ name: 'main', key: 'dsh-handeye', locale }, Panel))

      if (typeof ctx.effect === 'function') {
        ctx.effect(registerTab, 'dsh-handeye: conversation tab')
        ctx.effect(registerMain, 'dsh-handeye: main view')
      } else {
        registerTab()
        registerMain()
      }
    }

    function animateIfPossible(element, frames, options) {
      try {
        if (typeof window === 'undefined') return
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        if (!element || typeof element.animate !== 'function') return
        element.animate(frames, options)
      } catch {}
    }

    function onKey(event) {
      if (event.key === 'Escape') closeOverlay()
    }

    function closeOverlay() {
      const overlay = document.getElementById(OVERLAY_ID)
      document.removeEventListener('keydown', onKey)
      if (!overlay) return
      const reduce =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduce || typeof overlay.animate !== 'function') {
        overlay.remove()
        return
      }
      try {
        const anim = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in' })
        anim.onfinish = () => overlay.remove()
        if (typeof setTimeout === 'function') setTimeout(() => overlay.remove(), 200)
      } catch {
        overlay.remove()
      }
    }

    function openOverlay() {
      if (document.getElementById(OVERLAY_ID)) return

      const overlay = document.createElement('div')
      overlay.id = OVERLAY_ID
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483001;background:#0b0d11;display:flex;flex-direction:column;box-sizing:border-box'

      const bar = document.createElement('div')
      bar.style.cssText =
        'display:flex;align-items:center;gap:12px;padding:8px 12px;background:#14181f;' +
        'border-bottom:1px solid #262c36;font:12px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;' +
        'flex:0 0 auto;width:100%;box-sizing:border-box'
      const title = document.createElement('strong')
      title.textContent = 'HandEye'
      title.style.cssText = 'font-weight:600;letter-spacing:.2px'
      const hint = document.createElement('span')
      hint.textContent = 'Press Esc or click Close'
      hint.style.cssText = 'color:#e9edf3;opacity:.85;flex:1'

      // 大号 Close：120x32，白字深底，放在顶栏最右，肉眼可见
      const close = document.createElement('button')
      close.id = CLOSE_ID
      close.type = 'button'
      close.title = 'Close panel (Esc)'
      close.setAttribute('aria-label', 'Close panel')
      close.textContent = 'Close'
      close.style.cssText =
        'position:fixed;top:8px;right:12px;z-index:2147483003;height:32px;min-width:96px;padding:0 16px;' +
        'font:600 13px/1 "Segoe UI",system-ui,sans-serif;color:#fff;background:#2b3542;border:1px solid #4a5566;' +
        'border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;' +
        'transition:background .15s ease,transform .15s ease,box-shadow .15s ease;box-shadow:0 2px 10px rgba(0,0,0,.45)'
      close.onmouseenter = () => {
        close.style.background = '#3a4757'
        close.style.transform = 'scale(1.03)'
      }
      close.onmouseleave = () => {
        close.style.background = '#2b3542'
        close.style.transform = 'scale(1)'
      }
      close.onclick = closeOverlay

      const frame = document.createElement('iframe')
      frame.src = PANEL_URL + '?embed=1'
      frame.title = 'HandEye Control Panel'
      frame.style.cssText = 'flex:1;width:100%;border:0;background:#0b0d11;min-height:0'

      overlay.append(bar, close, frame)
      document.body.appendChild(overlay)

      animateIfPossible(overlay, [{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'scale(1)' }], {
        duration: 160,
        easing: 'ease-out',
      })
      animateIfPossible(frame, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', delay: 40 })

      document.addEventListener('keydown', onKey)
      if (typeof overlay.focus === 'function') {
        overlay.tabIndex = -1
        overlay.focus()
      }
      overlay.addEventListener('keydown', onKey)
    }

    function mountButton() {
      if (typeof document === 'undefined' || !document.body) return
      if (document.getElementById(BTN_ID)) return
      const btn = document.createElement('button')
      btn.id = BTN_ID
      btn.type = 'button'
      btn.textContent = 'HandEye'
      btn.title = 'Open the HandEye control panel'
      btn.style.cssText =
        'position:fixed;right:14px;bottom:88px;z-index:2147483000;font:600 12px/1 "Segoe UI",system-ui,sans-serif;' +
        'color:#fff;background:#1c2129;border:1px solid #3a4250;border-radius:999px;padding:8px 14px;cursor:pointer;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.45);transition:background .15s ease,transform .15s ease,box-shadow .15s ease'
      btn.onmouseenter = () => {
        btn.style.background = '#26303d'
        btn.style.transform = 'translateY(-1px)'
        btn.style.boxShadow = '0 4px 14px rgba(0,0,0,.55)'
      }
      btn.onmouseleave = () => {
        btn.style.background = '#1c2129'
        btn.style.transform = 'translateY(0)'
        btn.style.boxShadow = '0 2px 10px rgba(0,0,0,.45)'
      }
      btn.onclick = () => {
        try {
          openOverlay()
        } catch (error) {
          console.warn('[handeye] could not open the panel: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      document.body.appendChild(btn)
    }

    function apply(ctx) {
      let registered = false
      try {
        registerSlots(ctx)
        registered = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          ctx?.logger?.warn?.('handeye view registration skipped: ' + message)
        } catch {}
        console.warn('[handeye] view registration failed; falling back to the floating button: ' + message)
      }
      if (!registered) {
        try {
          mountButton()
        } catch {}
      }
    }

    // inject 必须声明：宿主据此把 slots 服务交给 ctx（缺了就是 undefined）
    return { inject: ['slots'], apply }
  },
})
