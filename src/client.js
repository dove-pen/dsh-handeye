// dsh-handeye — client half.
//
// 给用户看的活动面板：右下角一个小胶囊，显示"刚才 AI 用手眼做了什么"，
// 点开是最近几十条记录。数据来自宿主路由 /dsh-handeye/activity，同源读取，
// 不碰文件系统、不带任何凭证。
window.__ModuleLoader__.load({
  id: 'dsh-handeye',
  factory: () => {
    const NS = 'dsh-handeye'
    const POLL_MS = 2000
    const OPEN_KEY = 'dsh-handeye:panel-open'
    let styleEl = null

    function ensureStyle() {
      if (styleEl || typeof document === 'undefined') return
      styleEl = document.createElement('style')
      styleEl.dataset.dshPlugin = NS
      styleEl.textContent = `
        .dsh-he {
          position: fixed; right: 16px; top: 56px; z-index: 2147483000;
          width: 340px; max-width: calc(100vw - 32px);
          font: 12px/1.45 system-ui, "Noto Sans SC", sans-serif;
          color: #e7e1e9; user-select: none;
        }
        .dsh-he-head {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-radius: 12px;
          background: rgba(29,29,35,.94); border: 1px solid #48454e;
          box-shadow: 0 8px 24px rgba(0,0,0,.35);
          cursor: pointer; transition: border-color .15s ease;
        }
        .dsh-he.open .dsh-he-head { border-radius: 12px 12px 0 0; border-bottom-color: #35333b; }
        .dsh-he-head { box-shadow: 0 6px 20px rgba(0,0,0,.28); }
        .dsh-he-head:hover { border-color: #6b6873; }
        .dsh-he .dot { width: 8px; height: 8px; border-radius: 50%; background: #2fbf71; flex: 0 0 auto; }
        .dsh-he .dot.busy { background: #e0a355; }
        .dsh-he .dot.bad { background: #e05555; }
        .dsh-he .title { flex: 0 0 auto; white-space: nowrap; font-weight: 600; letter-spacing: .02em; }
        .dsh-he .latest {
          flex: 1 1 auto; min-width: 40px; overflow: hidden;
          color: #b6b1bd; white-space: nowrap; text-overflow: ellipsis;
        }
        .dsh-he .count {
          flex: 0 0 auto; padding: 1px 7px; border-radius: 999px;
          background: #35333b; color: #cfc9d6; font-variant-numeric: tabular-nums;
        }
        .dsh-he-list {
          display: none; max-height: 380px; overflow-y: auto;
          background: rgba(24,24,29,.97); border: 1px solid #48454e; border-top: 0;
          border-radius: 0 0 12px 12px; padding: 6px;
        }
        .dsh-he.open .dsh-he-list { display: block; }
        .dsh-he-row {
          display: grid; grid-template-columns: 52px 1fr; gap: 6px;
          padding: 5px 7px; border-radius: 8px;
        }
        .dsh-he-row + .dsh-he-row { margin-top: 1px; }
        .dsh-he-row:hover { background: #2a2830; }
        .dsh-he-time { color: #807b88; font-variant-numeric: tabular-nums; }
        .dsh-he-body { min-width: 0; }
        .dsh-he-tool { color: #8fb7ff; }
        .dsh-he-brief { color: #cfc9d6; word-break: break-word; }
        .dsh-he-row.bad .dsh-he-tool { color: #ff8f8f; }
        .dsh-he-row.bad .dsh-he-brief { color: #e0b7b7; }
        .dsh-he-empty { padding: 12px; color: #807b88; text-align: center; }
      `
      document.head.appendChild(styleEl)
    }

    async function request(path) {
      const res = await fetch(path, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    function clockText(iso) {
      try {
        return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return '--:--:--'
      }
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      const install = () => {
        ensureStyle()

        let open = false
        try {
          open = localStorage.getItem(OPEN_KEY) === '1'
        } catch { }
        let lastStamp = ''
        let initialised = false

        const root = document.createElement('div')
        root.className = 'dsh-he' + (open ? ' open' : '')

        const head = document.createElement('div')
        head.className = 'dsh-he-head'
        head.setAttribute('role', 'button')
        head.tabIndex = 0
        head.title = '手眼：显示 AI 刚才用这套工具做了什么（点击展开或收起）'

        const dot = document.createElement('span')
        dot.className = 'dot'
        const title = document.createElement('span')
        title.className = 'title'
        title.textContent = '手眼'
        const latest = document.createElement('span')
        latest.className = 'latest'
        latest.textContent = '等待第一次操作'
        const count = document.createElement('span')
        count.className = 'count'
        count.textContent = '0'

        head.appendChild(dot)
        head.appendChild(title)
        head.appendChild(latest)
        head.appendChild(count)

        const list = document.createElement('div')
        list.className = 'dsh-he-list'

        root.appendChild(head)
        root.appendChild(list)

        let alive = true

        const render = (items) => {
          if (!alive) return
          count.textContent = String(items.length)
          if (items.length === 0) {
            latest.textContent = '还没有操作'
            dot.className = 'dot'
            list.replaceChildren()
            const empty = document.createElement('div')
            empty.className = 'dsh-he-empty'
            empty.textContent = 'AI 还没用过这些工具'
            list.appendChild(empty)
            return
          }
          const last = items[items.length - 1]
          latest.textContent = `${last.tool} · ${last.brief}`
          dot.className = 'dot' + (last.ok ? '' : ' bad')

          // 只有内容变了才重建，避免每两秒闪一次。
          const stamp = `${items.length}:${last.t}`
          if (stamp === lastStamp) return
          const isNew = initialised && lastStamp !== ''
          lastStamp = stamp
          initialised = true

          list.replaceChildren()
          const slice = items.slice(-40).reverse()
          for (const it of slice) {
            const row = document.createElement('div')
            row.className = 'dsh-he-row' + (it.ok ? '' : ' bad')

            const t = document.createElement('div')
            t.className = 'dsh-he-time'
            t.textContent = clockText(it.t)

            const body = document.createElement('div')
            body.className = 'dsh-he-body'

            const tool = document.createElement('span')
            tool.className = 'dsh-he-tool'
            tool.textContent = it.tool

            const brief = document.createElement('div')
            brief.className = 'dsh-he-brief'
            brief.textContent = it.brief || ''

            body.appendChild(tool)
            body.appendChild(brief)
            row.appendChild(t)
            row.appendChild(body)
            list.appendChild(row)
          }

          if (isNew && !open) {
            root.animate(
              [{ boxShadow: '0 0 0 0 rgba(47,191,113,.55)' }, { boxShadow: '0 0 0 8px rgba(47,191,113,0)' }],
              { duration: 700, easing: 'ease-out' },
            )
          }
        }

        const refresh = async () => {
          try {
            const data = await request('/dsh-handeye/activity')
            render(Array.isArray(data?.items) ? data.items : [])
          } catch {
            // 宿主还没准备好，保持上一屏，不打扰用户。
          }
        }

        const toggle = () => {
          open = !open
          root.classList.toggle('open', open)
          try {
            localStorage.setItem(OPEN_KEY, open ? '1' : '0')
          } catch { }
        }

        head.addEventListener('click', toggle)
        head.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        })

        document.body.appendChild(root)
        refresh()
        const timer = setInterval(refresh, POLL_MS)

        const dispose = () => {
          alive = false
          clearInterval(timer)
          head.removeEventListener('click', toggle)
          root.remove()
        }
        ctx.effect(() => dispose)
        return dispose
      }

      if (document.body) return install()
      const observer = new MutationObserver(() => {
        if (document.body) {
          observer.disconnect()
          install()
        }
      })
      observer.observe(document.documentElement, { childList: true })
    }

    return { apply }
  },
})
