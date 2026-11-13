// dsh-handeye — client half（对外叫「HandEye / 手嘴眼」）。
//
// 铁律：客户端插件绝不能把宿主搞挂。所有东西包在 try/catch 里，
// 任何异常只让本插件的浮层入口消失，不影响 DSH 本身。
//
// v0.32.x：页签契约没有文档（点了不切换），改成自带浮层。
// v0.32.2：用户反馈"没有关闭按钮" —— 顶栏里的 Close 会被宿主标题栏吃掉，
//          改成固定在右上角的圆形 ×，z-index 更高，不依赖顶栏布局。
//          同时加入少量动效（淡入 + 轻微放大，按钮 hover 反馈），尊重 reduced-motion。

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
  factory: () => {
    const PANEL_URL = '/dsh-handeye-plus/dashboard'
    const BTN_ID = 'dsh-handeye-btn'
    const OVERLAY_ID = 'dsh-handeye-overlay'
    const CLOSE_ID = 'dsh-handeye-close'

    /** 少量动效：能关就关（reduced-motion 或老浏览器）。 */
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
      // 关闭也淡出，但不阻塞：立刻从 DOM 摘掉也行（用户点的是关闭）
      const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduce || typeof overlay.animate !== 'function') {
        overlay.remove()
        return
      }
      try {
        const anim = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in' })
        anim.onfinish = () => overlay.remove()
        // 兜底：动画事件不触发时也删
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
        'position:fixed;inset:0;z-index:2147483001;background:#0b0d11;display:flex;flex-direction:column;' +
        'box-sizing:border-box'

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

      // 关闭按钮：fixed 定位、自己带 z-index，不依赖顶栏布局，不会被宿主标题栏盖住
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

      // 少量动效：浮层淡入 + 轻微放大，面板稍微晚一点
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

    function apply() {
      try {
        mountButton()
      } catch (error) {
        console.warn('[handeye] could not mount the button: ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    return { apply }
  },
})
