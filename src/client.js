// dsh-handeye — client half（对外叫「HandEye / 手嘴眼」）。
//
// 一条铁律：**客户端插件绝不能把宿主搞挂**。
// 2026-11-13 出过事故：factory 顶层 require('react') 失败 → DSH 判定
// "web boot: entry did not activate" → 整个应用起不来。所以这里所有东西都包在
// try/catch 里，任何异常只让本插件的按钮消失，不影响 DSH 本身。
//
// 为什么不用宿主的"页签"注册（v0.32.0 的决定）：
//   页签的 slots 契约在宿主里没有文档，实测注册后按钮出现但点了不切换。
//   与其赌那个隐性契约，不如自己画一个浮层：按钮 + iframe，纯 DOM，一定能用。
//   仍然是"同一份 dashboard"，只是入口更笨、更可靠。

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

    function closeOverlay() {
      const overlay = document.getElementById(OVERLAY_ID)
      if (overlay) overlay.remove()
      document.removeEventListener('keydown', onKey)
    }

    function onKey(event) {
      if (event.key === 'Escape') closeOverlay()
    }

    function openOverlay() {
      if (document.getElementById(OVERLAY_ID)) return
      const overlay = document.createElement('div')
      overlay.id = OVERLAY_ID
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483001;background:#0b0d11;display:flex;flex-direction:column'

      const bar = document.createElement('div')
      bar.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:6px 10px;background:#14181f;border-bottom:1px solid #262c36;' +
        'font:12px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;flex:0 0 auto'
      const title = document.createElement('strong')
      title.textContent = 'HandEye'
      title.style.cssText = 'font-weight:600;letter-spacing:.2px'
      const hint = document.createElement('span')
      hint.textContent = 'Click Close or press Esc to return'
      hint.style.cssText = 'color:#e9edf3;opacity:.85'
      const spacer = document.createElement('span')
      spacer.style.cssText = 'flex:1'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = 'Close'
      close.style.cssText =
        'font:inherit;color:#fff;background:#1c2129;border:1px solid #3a4250;border-radius:6px;padding:3px 12px;cursor:pointer'
      close.onclick = closeOverlay
      bar.append(title, hint, spacer, close)

      const frame = document.createElement('iframe')
      frame.src = PANEL_URL + '?embed=1'
      frame.title = 'HandEye Control Panel'
      frame.style.cssText = 'flex:1;width:100%;border:0;background:#0b0d11;min-height:0'

      overlay.append(bar, frame)
      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKey)
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
        'box-shadow:0 2px 10px rgba(0,0,0,.45)'
      btn.onmouseenter = () => {
        btn.style.background = '#26303d'
      }
      btn.onmouseleave = () => {
        btn.style.background = '#1c2129'
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
