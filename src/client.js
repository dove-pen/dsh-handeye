// dsh-handeye — client half（对外叫「HandEye / 手嘴眼」）。
//
// 铁律：客户端插件绝不能把宿主搞挂。所有东西包在 try/catch 里。
//
// 注册方式照抄 dsh-context（"上下文"页签）：它用的是
//   ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-context', locale }, Component))
// v0.32.x 猜的那个页签槽（带 id/label/order）形状不对，按钮点了不切换。
// v0.33.0 改成 'main' + key：和"上下文"并列，**只占会话区**，不是全屏浮层。
//
// 兜底：万一 slots 不可用（宿主变版本 / 没给 react），退到右下角按钮 + 浮层，
//       保证"至少有一个入口"，但绝不抛错。

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

    let React = null
    let jsx = null
    try {
      // 只在 try 里 require：拿不到就退兜底，绝不让宿主判成 entry failed
      React = require('react')
      jsx = require('react/jsx-runtime').jsx
    } catch {
      React = null
      jsx = null
    }

    /** 面板内容：填满宿主的视图区域，高度交给宿主。 */
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

    /** 和"上下文"一样挂在 main 槽上：只占会话区。 */
    function registerView(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error('slots API is unavailable')
      }
      if (!jsx) throw new Error('react is unavailable')
      const locale = (ctx && ctx.locale) || {}
      const register = () =>
        slots.inject('main', () =>
          slots.register({ name: 'main', key: 'dsh-handeye', locale }, Panel),
        )
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-handeye: main view')
      else register()
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
        'display:flex;align-items:center;gap:10px;padding:6px 56px 6px 12px;background:#14181f;' +
        'border-bottom:1px solid #262c36;font:12px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;' +
        'flex:0 0 auto;width:100%;box-sizing:border-box'
      const title = document.createElement('strong')
      title.textContent = 'HandEye'
      title.style.cssText = 'font-weight:600;letter-spacing:.2px'
      const hint = document.createElement('span')
      hint.textContent = 'Click × or press Esc to return'
      hint.style.cssText = 'color:#e9edf3;opacity:.85'
      bar.append(title, hint)

      const close = document.createElement('button')
      close.id = CLOSE_ID
      close.type = 'button'
      close.title = 'Close panel (Esc)'
      close.setAttribute('aria-label', 'Close panel')
      close.textContent = '×'
      close.style.cssText =
        'position:fixed;top:10px;right:14px;z-index:2147483003;width:30px;height:30px;line-height:1;' +
        'font:400 20px/1 "Segoe UI",system-ui,sans-serif;color:#fff;background:#1c2129;border:1px solid #3a4250;' +
        'border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'transition:background .15s ease,transform .15s ease,box-shadow .15s ease;box-shadow:0 2px 10px rgba(0,0,0,.45)'
      close.onmouseenter = () => {
        close.style.background = '#2b3542'
        close.style.transform = 'scale(1.06)'
      }
      close.onmouseleave = () => {
        close.style.background = '#1c2129'
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

    /** 兜底入口：只在 main 槽注册失败时挂出来。 */
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
        registerView(ctx)
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

    return { apply }
  },
})
