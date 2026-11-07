// dsh-handeye — client half.
//
// 给用户看的"活动面板"：AI 刚才用手、眼、后台控件、浏览器做了什么。
//
// 视觉照 DSH 自己的设计变量走（--dsw-alias-*），所以深浅主题都能贴合宿主；
// 结构照 dsh-context 的路子来：KPI 卡片 + 分布环 + 可筛选时间线 + 插件信息。
// 数据只来自本插件的同源只读路由 /dsh-handeye/activity，不碰文件系统、不带凭证。
window.__ModuleLoader__.load({
  id: 'dsh-handeye',
  factory: () => {
    const NS = 'dsh-handeye'
    const POLL_MS = 1500
    const OPEN_KEY = 'dsh-handeye:panel-open'
    const MAX_ROWS = 120

    const ACCENT = {
      eye: '#5b8cff',
      hand: '#ffa14a',
      desk: '#33c07f',
      browser: '#b083ff',
      text: '#3fc6d8',
      other: '#8b8b95',
    }

    const CATEGORY = [
      { id: 'eye', label: '眼睛', test: (t) => /^eye_/.test(t) },
      { id: 'hand', label: '手', test: (t) => /^hand_/.test(t) },
      { id: 'desk', label: '后台', test: (t) => /^desk_/.test(t) },
      { id: 'browser', label: '浏览器', test: (t) => /^browser_/.test(t) },
      { id: 'text', label: '工具', test: (t) => /^eye_text$|^yl_log$/.test(t) },
    ]

    function categoryOf(tool) {
      for (const c of CATEGORY) if (c.test(tool)) return c.id
      return 'other'
    }

    function colorOf(tool) {
      return ACCENT[categoryOf(tool)] || ACCENT.other
    }

    function clockText(iso) {
      try {
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      } catch {
        return '--:--:--'
      }
    }

    function durationText(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n)) return ''
      if (n < 1000) return `${Math.round(n)}ms`
      return `${(n / 1000).toFixed(1)}s`
    }

    // ---------------------------------------------------------------- 样式
    function ensureStyle() {
      // 插件热重载时页面里可能残留上一版注入的 <style>（同名 data 属性）。
      // 直接覆盖内容，不能"有就不管"，否则新界面会套着旧 CSS 跑。
      let style = document.querySelector(`style[data-dsh-plugin="${NS}"]`)
      if (!style) {
        style = document.createElement('style')
        style.dataset.dshPlugin = NS
        document.head.appendChild(style)
      }
      // 色板优先用宿主变量，宿主没给时回落到深色默认值。
      style.textContent = `
        .dsh-he, .dsh-he * { box-sizing: border-box; }
        .dsh-he {
          --he-bg: var(--dsw-alias-bg-layer-1, #1a1a1f);
          --he-bg-2: var(--dsw-alias-bg-layer-2, #202027);
          --he-text: var(--dsw-alias-label-primary, #ececf2);
          --he-muted: var(--dsw-alias-label-secondary, #9a9aa6);
          --he-dim: var(--dsw-alias-label-tertiary, #74747f);
          --he-line: var(--dsw-alias-border-l2, #2e2e38);
          --he-hover: var(--dsw-alias-interactive-bg-hover, #26262f);
          position: fixed; inset: 0 0 0 auto; z-index: 2147483000;
          width: 430px; max-width: 94vw; pointer-events: none;
          font: 12px/1.5 system-ui, "Noto Sans SC", "Microsoft YaHei", sans-serif;
          color: var(--he-text);
        }
        .dsh-he-panel {
          position: absolute; inset: 62px 0 0 0; display: flex; flex-direction: column;
          background: var(--he-bg); border: 1px solid var(--he-line); border-right: 0;
          border-radius: 14px 0 0 0;
          box-shadow: -18px 0 48px rgba(0,0,0,.38);
          transform: translateX(102%); transition: transform .22s cubic-bezier(.2,.7,.3,1);
          pointer-events: auto;
        }
        .dsh-he.open .dsh-he-panel { transform: translateX(0); }
        .dsh-he-head {
          flex: none; padding: 14px 16px 12px; border-bottom: 1px solid var(--he-line);
          background: linear-gradient(180deg, var(--he-bg-2), var(--he-bg));
          position: relative;
        }
        .dsh-he-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; letter-spacing: .02em; }
        .dsh-he-title svg { color: var(--dsw-alias-brand-primary, #5b8cff); }
        .dsh-he-sub { margin-top: 3px; color: var(--he-muted); font-size: 11px; }
        .dsh-he-live { width: 7px; height: 7px; border-radius: 50%; background: #33c07f; box-shadow: 0 0 0 3px rgba(51,192,127,.14); }
        .dsh-he-live.busy { background: #ffa14a; box-shadow: 0 0 0 3px rgba(255,161,74,.16); }
        .dsh-he-close {
          position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border-radius: 8px;
          border: 0; background: transparent; color: var(--he-muted); font-size: 16px; line-height: 1; cursor: pointer;
        }
        .dsh-he-close:hover { background: var(--he-hover); color: var(--he-text); }
        .dsh-he-scroll { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px 8px; scrollbar-width: thin; }
        .dsh-he-scroll::-webkit-scrollbar { width: 8px; }
        .dsh-he-scroll::-webkit-scrollbar-thumb { background: #3a3a44; border-radius: 8px; }

        /* KPI */
        .dsh-he-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
        .dsh-he-kpi { background: var(--he-bg-2); border: 1px solid var(--he-line); border-radius: 10px; padding: 9px 10px; }
        .dsh-he-kpi b { display: block; font-size: 18px; font-weight: 700; letter-spacing: .01em; font-variant-numeric: tabular-nums; }
        .dsh-he-kpi span { display: block; margin-top: 2px; color: var(--he-muted); font-size: 10.5px; }
        .dsh-he-kpi.bad b { color: #ff6b6b; }

        /* 卡片 */
        .dsh-he-card { background: var(--he-bg-2); border: 1px solid var(--he-line); border-radius: 12px; padding: 11px 12px; margin-bottom: 10px; }
        .dsh-he-card-head { display: flex; align-items: center; gap: 6px; color: var(--he-muted); font-size: 11px; margin-bottom: 9px; }
        .dsh-he-card-head b { color: var(--he-text); font-size: 12px; font-weight: 600; }
        .dsh-he-card-head .right { margin-left: auto; color: var(--he-dim); font-variant-numeric: tabular-nums; }

        /* 分布环 */
        .dsh-he-dist { display: flex; align-items: center; gap: 14px; }
        .dsh-he-donut { flex: none; }
        .dsh-he-donut text { fill: var(--he-text); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .dsh-he-donut .cap { fill: var(--he-dim); font-size: 8px; font-weight: 400; }
        .dsh-he-legend { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
        .dsh-he-leg { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--he-muted); }
        .dsh-he-leg i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
        .dsh-he-leg .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--he-text); }
        .dsh-he-leg .num { font-variant-numeric: tabular-nums; color: var(--he-dim); }

        /* 失败卡 */
        .dsh-he-fails { border-color: rgba(255,107,107,.35); }
        .dsh-he-fails .dsh-he-fail { display: flex; gap: 7px; font-size: 11px; color: #ffb3b3; padding: 3px 0; }
        .dsh-he-fails .dsh-he-fail .fn { color: #ff8080; flex: none; font-variant-numeric: tabular-nums; }
        .dsh-he-fails .dsh-he-fail .ft { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* 时间线 */
        .dsh-he-bar { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0 9px; }
        .dsh-he-chip {
          border: 1px solid var(--he-line); background: transparent; color: var(--he-muted);
          border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer;
        }
        .dsh-he-chip:hover { background: var(--he-hover); color: var(--he-text); }
        .dsh-he-chip.on { background: var(--he-text); color: var(--he-bg); border-color: var(--he-text); }
        .dsh-he-empty { color: var(--he-dim); text-align: center; padding: 26px 8px; font-size: 12px; }
        .dsh-he-row { display: grid; grid-template-columns: 48px 12px 1fr; gap: 8px; padding: 6px 2px; border-radius: 8px; cursor: pointer; }
        .dsh-he-row:hover { background: var(--he-hover); }
        .dsh-he-row .time { color: var(--he-dim); font-size: 10.5px; font-variant-numeric: tabular-nums; padding-top: 2px; }
        .dsh-he-row .spine { display: flex; flex-direction: column; align-items: center; gap: 3px; padding-top: 5px; }
        .dsh-he-row .spine i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
        .dsh-he-row .spine s { flex: 1 1 auto; width: 1px; background: var(--he-line); }
        .dsh-he-row:last-child .spine s { display: none; }
        .dsh-he-row .body { min-width: 0; padding-bottom: 4px; }
        .dsh-he-row .rh { display: flex; align-items: center; gap: 6px; }
        .dsh-he-tag { font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 5px; line-height: 17px; }
        .dsh-he-row .dur { margin-left: auto; color: var(--he-dim); font-size: 10.5px; font-variant-numeric: tabular-nums; flex: none; }
        .dsh-he-row .brief { color: var(--he-muted); font-size: 11.5px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin-top: 2px; }
        .dsh-he-row.bad .brief { color: #ffb3b3; }
        .dsh-he-row .more { display: none; margin-top: 5px; padding: 6px 8px; background: var(--he-bg); border: 1px solid var(--he-line); border-radius: 8px; color: var(--he-muted); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
        .dsh-he-row.expanded .more { display: block; }
        .dsh-he-row .args { color: var(--he-dim); margin-top: 3px; }
        .dsh-he-row .args:empty { display: none; }

        /* 底部信息 */
        .dsh-he-meta {
          flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 14px;
          border-top: 1px solid var(--he-line); color: var(--he-dim); font-size: 10.5px;
          font-variant-numeric: tabular-nums;
        }
        .dsh-he-meta .grow { flex: 1; }
        .dsh-he-meta b { color: var(--he-muted); font-weight: 500; }

        /* 关闭时的挂件 */
        .dsh-he-pill {
          position: fixed; top: 62px; right: 14px; z-index: 2147483001;
          display: flex; align-items: center; gap: 7px; padding: 6px 11px 6px 9px;
          background: var(--he-bg); border: 1px solid var(--he-line); border-radius: 999px;
          color: var(--he-text); font: 11px/1.4 system-ui, "Noto Sans SC", sans-serif;
          box-shadow: 0 6px 20px rgba(0,0,0,.3); cursor: pointer; pointer-events: auto;
          opacity: 0; transform: translateY(-4px); transition: opacity .18s ease, transform .18s ease;
        }
        .dsh-he:not(.open) .dsh-he-pill { opacity: 1; transform: none; }
        .dsh-he-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #33c07f; }
        .dsh-he-pill .dot.busy { background: #ffa14a; }
        .dsh-he-pill .lab { color: var(--he-muted); }
        .dsh-he-pill .cnt { background: var(--he-hover); border-radius: 999px; padding: 0 6px; color: var(--he-muted); font-variant-numeric: tabular-nums; }
      `
    }

    // ---------------------------------------------------------------- 挂载
    function ensureExtraStyle() {
      const ID = 'dsh-he-extra'
      const css = `
        .dsh-he.has-tab .dsh-he-pill { display: none; }
        .dsh-he-tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--he-border, rgba(255,255,255,.08)); }
        .dsh-he-tabs button { flex: 1; border: 0; background: transparent; color: var(--he-muted); font: inherit; font-size: 12px; padding: 7px 0 8px; cursor: pointer; border-bottom: 2px solid transparent; }
        .dsh-he-tabs button.on { color: var(--he-text, #e8e8ea); border-bottom-color: #7aa2ff; }
        .dsh-he-page { display: none; }
        .dsh-he-page.on { display: block; }
        .dsh-he-statebar { display: none; margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
        .dsh-he-statebar.on { display: flex; align-items: center; gap: 8px; }
        .dsh-he-statebar.paused { background: rgba(255,107,107,.14); color: #ff9d9d; }
        .dsh-he-statebar.replan { background: rgba(255,161,74,.14); color: #ffc184; }
        .dsh-he-statebar button { margin-left: auto; }
        .dsh-he-item { border: 1px solid var(--he-border, rgba(255,255,255,.08)); border-radius: 8px; padding: 9px 10px; margin: 8px 12px; }
        .dsh-he-item .t { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--he-text, #e8e8ea); }
        .dsh-he-item .t b { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-he-item .g { margin-top: 5px; font-size: 11.5px; color: var(--he-muted); line-height: 1.5; }
        .dsh-he-item .row { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
        .dsh-he-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--he-hover, rgba(255,255,255,.08)); color: var(--he-muted); }
        .dsh-he-badge.read { color: #7fd19a; }
        .dsh-he-badge.write { color: #ffc184; }
        .dsh-he-badge.destructive { color: #ff8080; }
        .dsh-he-badge.on { color: #7fd19a; }
        .dsh-he-btn { border: 1px solid var(--he-border, rgba(255,255,255,.12)); background: var(--he-hover, rgba(255,255,255,.06)); color: var(--he-text, #e8e8ea); font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 6px; cursor: pointer; }
        .dsh-he-btn:hover { border-color: #7aa2ff; }
        .dsh-he-btn.danger { color: #ff9d9d; }
        .dsh-he-btn:disabled { opacity: .45; cursor: default; }
        .dsh-he-logrow { display: grid; grid-template-columns: 62px 34px 1fr; gap: 6px; padding: 5px 12px; font-size: 11.5px; border-bottom: 1px solid rgba(255,255,255,.04); cursor: pointer; }
        .dsh-he-logrow .tm { color: var(--he-muted); font-variant-numeric: tabular-nums; }
        .dsh-he-logrow .lv { font-size: 10.5px; text-align: center; border-radius: 4px; padding: 0 3px; }
        .dsh-he-logrow .ds { color: var(--he-text, #e8e8ea); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-he-logrow .dt { display: none; grid-column: 1 / -1; color: var(--he-muted); white-space: pre-wrap; word-break: break-all; padding: 4px 0 2px; }
        .dsh-he-logrow.open .dt { display: block; }
        .dsh-he-logkpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 10px 12px; }
        .dsh-he-logkpis div { background: var(--he-hover, rgba(255,255,255,.05)); border-radius: 8px; padding: 7px 8px; }
        .dsh-he-logkpis b { display: block; font-size: 15px; font-variant-numeric: tabular-nums; }
        .dsh-he-logkpis span { font-size: 10.5px; color: var(--he-muted); }
        .dsh-he-filters { display: flex; gap: 5px; padding: 0 12px 8px; flex-wrap: wrap; align-items: center; }
        .dsh-he-filters input { flex: 1; min-width: 80px; background: var(--he-hover, rgba(255,255,255,.06)); border: 1px solid var(--he-border, rgba(255,255,255,.1)); color: var(--he-text, #e8e8ea); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 11.5px; }
        .dsh-he-msg { padding: 18px 12px; font-size: 12px; color: var(--he-muted); }
      `
      let el = document.getElementById(ID)
      if (!el) {
        el = document.createElement('style')
        el.id = ID
        document.head.appendChild(el)
      }
      if (el.textContent !== css) el.textContent = css
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return

      const install = () => {
        ensureStyle()
        ensureExtraStyle()
        // 热重载时清掉上一版留下的根节点，避免两个面板叠在一起。
        document.querySelectorAll('.dsh-he').forEach((n) => n.remove())

        let open = false
        try {
          open = localStorage.getItem(OPEN_KEY) === '1'
        } catch { }
        let lastStamp = ''
        let dataStamp = ''
        let filter = 'all'
        let data = { items: [], meta: {} }
        let alive = true

        const root = document.createElement('div')
        root.className = 'dsh-he' + (open ? ' open' : '')

        // --- 面板骨架
        const panel = document.createElement('aside')
        panel.className = 'dsh-he-panel'

        const head = document.createElement('div')
        head.className = 'dsh-he-head'
        head.innerHTML = `
          <div class="dsh-he-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>
            </svg>
            手眼+
            <span class="dsh-he-live"></span>
          </div>
          <div class="dsh-he-sub">AI 最近用这套工具干了什么</div>
          <button class="dsh-he-close" aria-label="收起">×</button>
          <div class="dsh-he-tabs">
            <button data-tab="today" class="on">今天</button>
            <button data-tab="caps">能力</button>
            <button data-tab="cards">任务卡</button>
            <button data-tab="log">日志</button>
          </div>
        `
        const closeBtn = head.querySelector('.dsh-he-close')
        const liveDot = head.querySelector('.dsh-he-live')
        const subEl = head.querySelector('.dsh-he-sub')
        const tabEls = [...head.querySelectorAll('.dsh-he-tabs button')]

        const scroll = document.createElement('div')
        scroll.className = 'dsh-he-scroll'

        const kpis = document.createElement('div')
        kpis.className = 'dsh-he-kpis'

        const distCard = document.createElement('div')
        distCard.className = 'dsh-he-card'

        const failsCard = document.createElement('div')
        failsCard.className = 'dsh-he-card dsh-he-fails'
        failsCard.style.display = 'none'

        const episodeCard = document.createElement('div')
        episodeCard.className = 'dsh-he-card'
        episodeCard.style.display = 'none'

        const bar = document.createElement('div')
        bar.className = 'dsh-he-bar'

        const list = document.createElement('div')
        list.className = 'dsh-he-list'

        const stateBar = document.createElement('div')
        stateBar.className = 'dsh-he-statebar'
        stateBar.innerHTML = '<span class="txt"></span><button class="dsh-he-btn" data-act="resume">恢复</button>'
        const stateText = stateBar.querySelector('.txt')
        const stateResume = stateBar.querySelector('button')

        const pageToday = document.createElement('div')
        pageToday.className = 'dsh-he-page on'
        for (const el of [kpis, distCard, failsCard, episodeCard, bar, list]) pageToday.appendChild(el)

        const pageCaps = document.createElement('div')
        pageCaps.className = 'dsh-he-page'
        const pageCards = document.createElement('div')
        pageCards.className = 'dsh-he-page'
        const pageLog = document.createElement('div')
        pageLog.className = 'dsh-he-page'

        scroll.appendChild(stateBar)
        scroll.appendChild(pageToday)
        scroll.appendChild(pageCaps)
        scroll.appendChild(pageCards)
        scroll.appendChild(pageLog)

        const meta = document.createElement('div')
        meta.className = 'dsh-he-meta'

        panel.appendChild(head)
        panel.appendChild(scroll)
        panel.appendChild(meta)
        root.appendChild(panel)

        // --- 关闭状态的挂件
        const pill = document.createElement('button')
        pill.className = 'dsh-he-pill'
        pill.innerHTML = '<span class="dot"></span><span class="lab">手眼</span><span class="cnt">0</span>'
        root.appendChild(pill)

        const pillDot = pill.querySelector('.dot')
        const pillCnt = pill.querySelector('.cnt')
        const pillLab = pill.querySelector('.lab')

        // --- 渲染
        const kpiItems = [
          { key: 'total', label: '操作' },
          { key: 'ok', label: '成功' },
          { key: 'bad', label: '失败' },
          { key: 'avg', label: '平均耗时' },
        ]
        const kpiEls = {}
        for (const k of kpiItems) {
          const el = document.createElement('div')
          el.className = 'dsh-he-kpi'
          if (k.key === 'bad') el.classList.add('bad')
          el.innerHTML = `<b>0</b><span>${k.label}</span>`
          kpiEls[k.key] = el
          kpis.appendChild(el)
        }

        const filters = [
          { id: 'all', label: '全部' },
          { id: 'bad', label: '失败' },
          { id: 'eye', label: '眼睛' },
          { id: 'hand', label: '手' },
          { id: 'desk', label: '后台' },
          { id: 'browser', label: '浏览器' },
        ]
        let filterEls = []
        function renderBar() {
          bar.replaceChildren()
          filterEls = filters.map((f) => {
            const b = document.createElement('button')
            b.className = 'dsh-he-chip' + (filter === f.id ? ' on' : '')
            b.textContent = f.label
            b.addEventListener('click', (e) => {
              e.stopPropagation()
              filter = f.id
              renderBar()
              renderRows(true)
            })
            bar.appendChild(b)
            return b
          })
        }

        function matches(it) {
          if (filter === 'all') return true
          if (filter === 'bad') return !it.ok
          return categoryOf(it.tool) === filter
        }

        function renderKpis(items) {
          const total = items.length
          const okN = items.filter((x) => x.ok).length
          const badN = total - okN
          const msList = items.map((x) => Number(x.ms)).filter((n) => Number.isFinite(n) && n >= 0)
          const avg = msList.length ? msList.reduce((a, b) => a + b, 0) / msList.length : 0
          kpiEls.total.querySelector('b').textContent = String(total)
          kpiEls.ok.querySelector('b').textContent = String(okN)
          kpiEls.bad.querySelector('b').textContent = String(badN)
          kpiEls.bad.classList.toggle('bad', badN > 0)
          kpiEls.avg.querySelector('b').textContent = avg ? durationText(avg) : '—'
        }

        function renderDist(items) {
          distCard.replaceChildren()
          const headEl = document.createElement('div')
          headEl.className = 'dsh-he-card-head'
          headEl.innerHTML = `<b>工具分布</b><span class="right">${items.length} 次</span>`
          distCard.appendChild(headEl)

          if (!items.length) {
            const empty = document.createElement('div')
            empty.className = 'dsh-he-empty'
            empty.textContent = 'AI 还没用过这些工具'
            distCard.appendChild(empty)
            return
          }

          const counts = new Map()
          for (const it of items) counts.set(it.tool, (counts.get(it.tool) || 0) + 1)
          const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
          const top = entries.slice(0, 5)
          const rest = entries.slice(5).reduce((s, [, n]) => s + n, 0)
          if (rest) top.push(['其他', rest])

          const total = items.length
          const R = 26
          const C = 2 * Math.PI * R
          let acc = 0
          const segs = top
            .map(([name, n]) => {
              const frac = n / total
              const seg = {
                name,
                n,
                frac,
                color: name === '其他' ? '#55555f' : colorOf(name),
                offset: acc,
              }
              acc += frac
              return seg
            })
            .map((s) => {
              const len = Math.max(C * s.frac - 2, 0.5)
              return `<circle cx="34" cy="34" r="${R}" fill="none" stroke="${s.color}" stroke-width="8"
                        stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-C * s.offset}"
                        transform="rotate(-90 34 34)" stroke-linecap="butt"></circle>`
            })
            .join('')

          const donut = document.createElement('div')
          donut.innerHTML = `
            <svg class="dsh-he-donut" width="68" height="68" viewBox="0 0 68 68">
              <circle cx="34" cy="34" r="${R}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="8"></circle>
              ${segs}
              <text x="34" y="34" text-anchor="middle" dominant-baseline="central">${total}</text>
              <text class="cap" x="34" y="47" text-anchor="middle">次</text>
            </svg>`
          const legend = document.createElement('div')
          legend.className = 'dsh-he-legend'
          for (const [name, n] of top) {
            const row = document.createElement('div')
            row.className = 'dsh-he-leg'
            const pct = Math.round((n / total) * 100)
            row.innerHTML = `<i style="background:${name === '其他' ? '#55555f' : colorOf(name)}"></i>
              <span class="name"></span><span class="num">${n} · ${pct}%</span>`
            row.querySelector('.name').textContent = name
            legend.appendChild(row)
          }
          const wrap = document.createElement('div')
          wrap.className = 'dsh-he-dist'
          wrap.appendChild(donut)
          wrap.appendChild(legend)
          distCard.appendChild(wrap)
        }

        function renderFails(items) {
          failsCard.replaceChildren()
          const bad = items.filter((x) => !x.ok)
          if (!bad.length) {
            failsCard.style.display = 'none'
            return
          }
          failsCard.style.display = ''
          const headEl = document.createElement('div')
          headEl.className = 'dsh-he-card-head'
          headEl.innerHTML = `<b>最近失败</b><span class="right">${bad.length} 条</span>`
          failsCard.appendChild(headEl)
          for (const it of bad.slice(-3).reverse()) {
            const row = document.createElement('div')
            row.className = 'dsh-he-fail'
            row.innerHTML = `<span class="fn"></span><span class="ft"></span>`
            row.querySelector('.fn').textContent = it.tool
            const text = String(it.brief || '').replace(new RegExp(`^${it.tool}\\s*(失败：)?`), '')
            row.querySelector('.ft').textContent = text || '（没有说明）'
            failsCard.appendChild(row)
          }
        }

        function renderRows(force = false) {
          const shown = data.items.filter(matches)
          const stamp = `${shown.length}:${data.items.length}:${shown.length ? shown[shown.length - 1].t : ''}:${filter}`
          if (!force && stamp === lastStamp) return
          lastStamp = stamp

          list.replaceChildren()
          if (!shown.length) {
            const empty = document.createElement('div')
            empty.className = 'dsh-he-empty'
            empty.textContent = filter === 'all' ? '还没有操作记录。' : '这个筛选下没有记录。'
            list.appendChild(empty)
            return
          }

          for (const it of shown.slice(-MAX_ROWS).reverse()) {
            const row = document.createElement('div')
            row.className = 'dsh-he-row' + (it.ok ? '' : ' bad')

            const time = document.createElement('div')
            time.className = 'time'
            time.textContent = clockText(it.t)

            const spine = document.createElement('div')
            spine.className = 'spine'
            const d = document.createElement('i')
            d.style.background = it.ok ? colorOf(it.tool) : '#ff6b6b'
            spine.appendChild(d)
            spine.appendChild(document.createElement('s'))

            const body = document.createElement('div')
            body.className = 'body'

            const rh = document.createElement('div')
            rh.className = 'rh'
            const tag = document.createElement('span')
            tag.className = 'dsh-he-tag'
            tag.textContent = it.tool
            tag.style.color = it.ok ? colorOf(it.tool) : '#ff8080'
            tag.style.background = hexA(it.ok ? colorOf(it.tool) : '#ff6b6b', 0.13)
            const dur = document.createElement('span')
            dur.className = 'dur'
            dur.textContent = durationText(it.ms)
            rh.appendChild(tag)
            rh.appendChild(dur)

            const brief = document.createElement('div')
            brief.className = 'brief'
            brief.textContent = it.brief || '（没有输出）'

            const more = document.createElement('div')
            more.className = 'more'
            const argsLine = document.createElement('div')
            argsLine.className = 'args'
            argsLine.textContent = it.args ? `参数：${it.args}` : ''
            const fullLine = document.createElement('div')
            fullLine.textContent = it.ok ? '' : '状态：失败'
            more.appendChild(argsLine)
            more.appendChild(fullLine)

            body.appendChild(rh)
            body.appendChild(brief)
            body.appendChild(more)

            row.appendChild(time)
            row.appendChild(spine)
            row.appendChild(body)

            row.addEventListener('click', () => {
              row.classList.toggle('expanded')
            })

            list.appendChild(row)
          }
        }

        function hexA(hex, alpha) {
          const h = String(hex).replace('#', '')
          const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
          const r = (n >> 16) & 255
          const g = (n >> 8) & 255
          const b = n & 255
          return `rgba(${r},${g},${b},${alpha})`
        }

        function renderMeta() {
          const m = data.meta || {}
          meta.innerHTML = `<span>手眼+ <b>v${(m.version || '?')}</b></span><span>·</span>
            <span>handeye <b>${(m.exe || '').split('\\').pop() || '?'}</b></span><span class="grow"></span>
            <button class="dsh-he-btn" data-act="pause">暂停</button>`
          const btn = meta.querySelector('button')
          if (btn) {
            btn.onclick = async () => {
              const paused = runtimeState?.state === 'PAUSED'
              await postJson('/dsh-handeye-plus/control', {
                action: paused ? 'resume' : 'pause',
                reason: paused ? '' : '用户从面板暂停',
              })
              void loadState()
            }
          }
        }

        function renderAll(items, meta) {
          data.items = items
          data.meta = meta || data.meta
          renderKpis(items)
          renderDist(items)
          renderFails(items)
          renderRows()
          renderMeta()

          const last = items[items.length - 1]
          if (!last) {
            pillCnt.textContent = '0'
            pillLab.textContent = '手眼'
            pillDot.className = 'dot'
            liveDot.className = 'dsh-he-live'
            return
          }
          pillCnt.textContent = String(items.length)
          pillLab.textContent = last.tool
          pillDot.className = 'dot' + (last.ok ? '' : ' busy')
          liveDot.className = 'dsh-he-live' + (last.ok ? '' : ' busy')
        }

        const refresh = async () => {
          try {
            const res = await fetch('/dsh-handeye/activity', { credentials: 'same-origin' })
            if (!res.ok) return
            const payload = await res.json()
            if (!alive) return
            const items = Array.isArray(payload?.items) ? payload.items : []
            const m = payload?.meta || {}
            // 没新东西就不重绘，避免每 1.5 秒闪一次。
            const stamp = `${items.length}:${items.length ? items[items.length - 1].t : ''}:${m.version || ''}`
            if (stamp === dataStamp) return
            dataStamp = stamp
            renderAll(items, m)
          } catch {
            // 宿主还没准备好，保持上一屏，不打扰用户。
          }
        }

        // 把入口挂到宿主顶部的「对话 / 轨迹 / 上下文 / 编队」那一排。
        // 宿主没有公开的插槽 API 时，用 DOM 方式补一个同款的按钮；找不到就退回右下角挂件。
        function mountTopTab() {
          if (!document.body) return
          if (document.querySelector('[data-dsh-he-tab]')) {
            root.classList.add('has-tab')
            return
          }
          const candidates = [...document.querySelectorAll('button, a, [role="tab"]')]
          const anchor = candidates.find((node) => {
            const text = String(node.textContent || '').trim()
            return (text === '编队' || text === '上下文' || text === '轨迹') && node.children.length <= 2
          })
          if (!anchor || !anchor.parentElement) return
          const tab = document.createElement('button')
          tab.type = 'button'
          tab.dataset.dshHeTab = '1'
          tab.className = anchor.className
          tab.textContent = '手眼+'
          tab.style.cssText =
            'background:transparent;border:0;font:inherit;cursor:pointer;padding:6px 10px;pointer-events:auto;position:relative;z-index:5'
          const openPanel = (event) => {
            if (event) {
              event.preventDefault()
              event.stopPropagation()
            }
            toggle(true)
          }
          tab.addEventListener('pointerdown', openPanel, true)
          tab.addEventListener('click', openPanel, true)
          anchor.parentElement.insertBefore(tab, anchor.nextSibling)
          root.classList.add('has-tab')
        }

        // Delegated in the capture phase: the host may re-render the tab row and
        // replace our button, so a per-button listener is not reliable enough.
        function onTopTabClick(event) {
          const target = event.target
          const tab = target && typeof target.closest === 'function' ? target.closest('[data-dsh-he-tab]') : null
          if (!tab) return
          event.preventDefault()
          event.stopPropagation()
          toggle(true)
        }
        document.addEventListener('click', onTopTabClick, true)

        const toggle = (next) => {
          open = typeof next === 'boolean' ? next : !open
          root.classList.toggle('open', open)
          try {
            localStorage.setItem(OPEN_KEY, open ? '1' : '0')
          } catch { }
        }

        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          toggle(false)
        })
        pill.addEventListener('click', () => toggle(true))
        panel.addEventListener('click', (e) => e.stopPropagation())
        document.addEventListener('keydown', onKey)

        function onKey(e) {
          if (e.key === 'Escape' && open) toggle(false)
        }

        // ------------------------------------------------ 页签、能力、任务卡、日志
        let tab = 'today'
        let runtimeState = null
        let logEvents = []
        let logLevel = 'all'
        let logQuery = ''
        let logLoaded = false

        const mk = (tag, cls, text) => {
          const node = document.createElement(tag)
          if (cls) node.className = cls
          if (text !== undefined) node.textContent = text
          return node
        }

        async function postJson(url, body) {
          const res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          try {
            return await res.json()
          } catch {
            return { ok: false }
          }
        }

        function setTab(next) {
          tab = next
          for (const b of tabEls) b.classList.toggle('on', b.dataset.tab === next)
          const pages = { today: pageToday, caps: pageCaps, cards: pageCards, log: pageLog }
          for (const [key, page] of Object.entries(pages)) page.classList.toggle('on', key === next)
          subEl.textContent =
            {
              today: 'AI 最近用这套工具干了什么',
              caps: '记忆下来的操作，第二次不用再想',
              cards: '选一张任务卡直接发给 AI',
              log: 'handeye 七段日志：谁、做了什么、成没成',
            }[next] || ''
          if (next === 'today') void loadEpisodes()
          if (next === 'caps') void loadCaps()
          if (next === 'cards') void loadCards()
          if (next === 'log') void loadLog()
        }

        for (const b of tabEls) b.addEventListener('click', () => setTab(b.dataset.tab))

        async function loadState() {
          try {
            const res = await fetch('/dsh-handeye-plus/state', { credentials: 'same-origin' })
            if (!res.ok) return
            runtimeState = await res.json()
            renderState()
          } catch { }
        }

        async function loadEpisodes() {
          try {
            const res = await fetch('/dsh-handeye-plus/episodes?limit=5', { credentials: 'same-origin' })
            if (!res.ok) return
            const payload = await res.json()
            if (!payload.ok) return
            renderEpisodes(Array.isArray(payload.value) ? payload.value : [])
          } catch { }
        }

        function episodeTiming(ep) {
          const start = new Date(ep.startedAt).getTime()
          const end = ep.endedAt ? new Date(ep.endedAt).getTime() : null
          const tool = (ep.steps || []).reduce((sum, step) => sum + (Number(step.ms) || 0), 0)
          if (!end || Number.isNaN(start) || Number.isNaN(end)) return '进行中'
          const wall = Math.max(0, end - start)
          const decision = Math.max(0, wall - tool)
          return `总 ${(wall / 1000).toFixed(1)}s · 执行 ${(tool / 1000).toFixed(1)}s · 决策 ${(decision / 1000).toFixed(1)}s`
        }

        function renderEpisodes(episodes) {
          // Do not wipe an inline "save as capability" form that the user is editing.
          if (episodeCard.querySelector('input')) return
          episodeCard.replaceChildren()
          if (!episodes.length) {
            episodeCard.style.display = 'none'
            return
          }
          episodeCard.style.display = ''
          const heading = mk('div', '', '最近任务')
          heading.style.cssText = 'font-size:11.5px;color:var(--he-muted);margin-bottom:6px'
          episodeCard.appendChild(heading)

          for (const ep of episodes) {
            const row = mk('div')
            row.style.cssText =
              'display:flex;align-items:center;gap:6px;padding:5px 0;border-top:1px solid rgba(255,255,255,.05);font-size:11.5px'
            const info = mk('div')
            info.style.cssText = 'flex:1;min-width:0'
            const label = mk(
              'div',
              '',
              `${String(ep.startedAt || '').slice(11, 16)}  ${ep.intent?.text || ep.intent || '（无意图）'}  ${ep.outcome || ''}`,
            )
            label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--he-text,#e8e8ea)'
            const metrics = mk('div', '', episodeTiming(ep))
            metrics.style.cssText = 'font-size:10.5px;color:var(--he-muted);margin-top:2px'
            info.appendChild(label)
            info.appendChild(metrics)
            const saveBtn = mk('button', 'dsh-he-btn', '存成能力')
            saveBtn.onclick = () => beginSaveEpisode(ep, row)
            row.appendChild(info)
            row.appendChild(saveBtn)
            episodeCard.appendChild(row)
          }
        }

        function episodeMessage(text, ok = true) {
          let message = episodeCard.querySelector('.dsh-he-ep-msg')
          if (!message) {
            message = mk('div')
            message.className = 'dsh-he-ep-msg'
            episodeCard.appendChild(message)
          }
          message.style.cssText = `font-size:11px;margin-top:6px;color:${ok ? '#7fd19a' : '#ff8080'}`
          message.textContent = text
        }

        function beginSaveEpisode(ep, row) {
          row.replaceChildren()
          const inputStyle =
            'font:inherit;font-size:11px;background:var(--he-hover,rgba(255,255,255,.06));border:1px solid var(--he-border,rgba(255,255,255,.12));color:var(--he-text,#e8e8ea);border-radius:5px;padding:3px 5px'
          const name = document.createElement('input')
          name.placeholder = '能力名'
          name.style.cssText = `${inputStyle};width:86px`
          const title = document.createElement('input')
          title.placeholder = '标题'
          title.value = ep.intent?.text || ''
          title.style.cssText = `${inputStyle};flex:1;min-width:60px`
          const ok = mk('button', 'dsh-he-btn', '保存')
          const cancel = mk('button', 'dsh-he-btn', '取消')
          cancel.onclick = () => loadEpisodes()
          ok.onclick = async () => {
            const nameValue = name.value.trim()
            const titleValue = title.value.trim()
            if (!nameValue || !titleValue) {
              episodeMessage('名称和标题都要填', false)
              return
            }
            ok.disabled = true
            const res = await postJson('/dsh-handeye-plus/capabilities/save', {
              episodeId: ep.id,
              name: nameValue,
              title: titleValue,
            })
            if (res.ok) {
              episodeMessage(`已保存草稿 ${nameValue}，去「能力」页检查并启用`, true)
              void loadCaps()
              window.setTimeout(() => loadEpisodes(), 1200)
            } else {
              episodeMessage(`保存失败：${res.error || res.message || 'unknown error'}`, false)
              ok.disabled = false
            }
          }
          row.appendChild(name)
          row.appendChild(title)
          row.appendChild(ok)
          row.appendChild(cancel)
        }

        function renderState() {
          const s = runtimeState
          if (!s) return
          const paused = s.state === 'PAUSED'
          const replan = s.state === 'REPLAN_REQUIRED' || s.needsReplan
          stateBar.classList.toggle('on', paused || replan)
          stateBar.classList.toggle('paused', paused)
          stateBar.classList.toggle('replan', !paused && replan)
          if (paused) stateText.textContent = `已暂停：${s.reason || '等待用户恢复'}`
          if (!paused && replan) stateText.textContent = `等待 AI 复述计划：${s.reason || ''}`
          stateResume.style.display = paused ? '' : 'none'
          stateResume.onclick = async () => {
            await postJson('/dsh-handeye-plus/control', { action: 'resume' })
            void loadState()
          }
          if (paused) pillDot.className = 'dot busy'
        }

        async function loadCaps() {
          try {
            const res = await fetch('/dsh-handeye-plus/capabilities', { credentials: 'same-origin' })
            if (!res.ok) return
            const payload = await res.json()
            if (!payload.ok) return
            renderCaps(Array.isArray(payload.value) ? payload.value : [])
          } catch { }
        }

        function renderCaps(caps) {
          pageCaps.replaceChildren()
          pageCaps.appendChild(
            mk('div', 'dsh-he-msg', `共 ${caps.length} 条 · 只读首次需授权，写操作每次需授权；点「授权」等价于你亲手同意一次`),
          )
          if (!caps.length) {
            pageCaps.appendChild(mk('div', 'dsh-he-msg', '还没有能力。'))
            return
          }
          for (const cap of caps) {
            const item = mk('div', 'dsh-he-item')
            const title = mk('div', 't')
            title.appendChild(mk('b', '', cap.title || cap.name))
            title.appendChild(mk('span', 'dsh-he-badge' + (cap.status === 'enabled' ? ' on' : ''), cap.status || 'draft'))
            title.appendChild(mk('span', 'dsh-he-badge ' + (cap.risk || 'read'), cap.risk || 'read'))
            title.appendChild(mk('span', 'dsh-he-badge', cap.origin || 'user'))

            const goal = mk('div', 'g', cap.description || cap.name)
            const row = mk('div', 'row')
            row.appendChild(mk('span', 'dsh-he-badge', `runs ${cap.stats?.runs ?? 0} / ok ${cap.stats?.success ?? 0}`))

            const toggle = mk('button', 'dsh-he-btn', cap.status === 'enabled' ? '禁用' : '启用')
            toggle.onclick = async () => {
              await postJson('/dsh-handeye-plus/capabilities/set', { name: cap.name, enabled: cap.status !== 'enabled' })
              void loadCaps()
            }
            row.appendChild(toggle)

            if (cap.status === 'enabled') {
              const grant = mk('button', 'dsh-he-btn', '授权本次')
              grant.onclick = async () => {
                await postJson('/dsh-handeye-plus/grant', { name: cap.name, risk: cap.risk })
                grant.textContent = '已授权'
                grant.disabled = true
              }
              row.appendChild(grant)
            }

            item.appendChild(title)
            item.appendChild(goal)
            item.appendChild(row)
            pageCaps.appendChild(item)
          }
        }

        async function loadCards() {
          try {
            const res = await fetch('/dsh-handeye-plus/cards', { credentials: 'same-origin' })
            if (!res.ok) return
            const payload = await res.json()
            if (!payload.ok) return
            renderCards(Array.isArray(payload.value) ? payload.value : [])
          } catch { }
        }

        function renderCards(cards) {
          pageCards.replaceChildren()
          pageCards.appendChild(mk('div', 'dsh-he-msg', `共 ${cards.length} 张 · 「发送」会把任务卡写进对话框并直接发出去`))
          for (const card of cards) {
            const item = mk('div', 'dsh-he-item')
            const title = mk('div', 't')
            title.appendChild(mk('b', '', card.title))
            title.appendChild(mk('span', 'dsh-he-badge', card.origin || 'builtin'))
            title.appendChild(mk('span', 'dsh-he-badge', card.autonomy || 'supervised'))
            const goal = mk('div', 'g', card.goal)
            const row = mk('div', 'row')

            const send = mk('button', 'dsh-he-btn', '发送')
            send.onclick = () => sendCard(card)
            row.appendChild(send)

            const detail = mk('button', 'dsh-he-btn', '详情')
            detail.onclick = () => {
              goal.textContent = [
                card.goal,
                ...(card.constraints || []).map((x) => `· ${x}`),
                `成功：${card.success}`,
                card.onFailure ? `失败时：${card.onFailure}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            }
            row.appendChild(detail)

            item.appendChild(title)
            item.appendChild(goal)
            item.appendChild(row)
            pageCards.appendChild(item)
          }
        }

        function formatCard(card) {
          const lines = [`【任务卡｜${card.title}｜${card.origin}｜${card.autonomy}｜v${card.version}】`, `目标：${card.goal}`]
          if (card.constraints && card.constraints.length) {
            lines.push('约束：')
            for (const rule of card.constraints) lines.push(`- ${rule}`)
          }
          lines.push(`成功标准：${card.success}`)
          if (card.onFailure) lines.push(`失败时：${card.onFailure}`)
          if (card.capabilities && card.capabilities.length) lines.push(`可用能力：${card.capabilities.join('、')}`)
          if (card.allowedTools && card.allowedTools.length) lines.push(`允许工具：${card.allowedTools.join(', ')}`)
          lines.push('任务已开始（episode 已记录），直接执行；需要重新规划时调用 episode_replan。')
          return lines.join('\n')
        }

        function findComposer() {
          const all = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
          const visible = all.filter((node) => node.offsetParent !== null && !node.closest('.dsh-he'))
          const byPlaceholder = visible.find((node) => /发消息|创建任务|message|describe/i.test(node.getAttribute('placeholder') || ''))
          return byPlaceholder || visible[visible.length - 1] || null
        }

        function fillComposer(box, text) {
          box.focus()
          if (box.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(box, text)
            box.dispatchEvent(new Event('input', { bubbles: true }))
            return
          }
          box.textContent = text
          box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        }

        async function sendCard(card) {
          const text = formatCard(card)
          const box = findComposer()
          if (!box) {
            pageCards.prepend(mk('div', 'dsh-he-msg', '没有找到输入框，请先打开一个会话再试。'))
            return
          }
          // Start the episode server-side so the model does not spend a round-trip
          // on episode_begin.
          await postJson('/dsh-handeye-plus/control', {
            action: 'begin',
            intent: card.title,
            allowedTools: card.allowedTools,
          }).catch(() => {})
          fillComposer(box, text)
          window.setTimeout(() => {
            const sendBtn = [...document.querySelectorAll('button')].find((b) => {
              const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`
              return /发送消息|send message/i.test(label) && !b.disabled
            })
            if (sendBtn) sendBtn.click()
            else
              box.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
              )
          }, 80)
        }

        async function loadLog() {
          try {
            const query = new URLSearchParams({ tail: '200' })
            if (logLevel !== 'all') query.set('level', logLevel)
            if (logQuery) query.set('grep', logQuery)
            const res = await fetch(`/dsh-handeye-plus/log/tail?${query}`, { credentials: 'same-origin' })
            if (!res.ok) return
            const payload = await res.json()
            if (!payload.ok) return
            logEvents = Array.isArray(payload.events) ? payload.events : []
            logLoaded = true
            renderLog()
          } catch { }
        }

        function renderLog() {
          pageLog.replaceChildren()
          const events = logEvents
          const errors = events.filter((e) => e.level <= 2).length
          const warnings = events.filter((e) => e.level === 3).length
          const sources = new Set(events.map((e) => e.source).filter(Boolean)).size

          const kpisEl = mk('div', 'dsh-he-logkpis')
          for (const [value, label] of [
            [events.length, '事件'],
            [errors, '错误'],
            [warnings, '警告'],
            [sources, '来源'],
          ]) {
            const cell = mk('div')
            cell.appendChild(mk('b', '', String(value)))
            cell.appendChild(mk('span', '', label))
            kpisEl.appendChild(cell)
          }
          pageLog.appendChild(kpisEl)

          const filters = mk('div', 'dsh-he-filters')
          for (const [id, label] of [
            ['all', '全部'],
            ['错误', '错误'],
            ['警告', '警告'],
            ['信息', '信息'],
          ]) {
            const chip = mk('button', 'dsh-he-chip' + (logLevel === id ? ' on' : ''), label)
            chip.onclick = () => {
              logLevel = id
              void loadLog()
            }
            filters.appendChild(chip)
          }
          const search = document.createElement('input')
          search.placeholder = '搜索日志'
          search.value = logQuery
          search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              logQuery = search.value.trim()
              void loadLog()
            }
          })
          filters.appendChild(search)
          pageLog.appendChild(filters)

          if (!events.length) {
            pageLog.appendChild(mk('div', 'dsh-he-msg', logLoaded ? '没有匹配的日志。' : '正在读取日志…'))
            return
          }

          const levelColor = { 1: '#ff6b6b', 2: '#ff6b6b', 3: '#ffa14a', 4: '#7aa2ff', 5: '#8a8a92' }
          for (const e of events.slice().reverse().slice(0, 200)) {
            const row = mk('div', 'dsh-he-logrow')
            row.appendChild(mk('span', 'tm', String(e.time || '').slice(11, 19) || String(e.time || '')))
            const lv = mk('span', 'lv', String(e.levelName || e.level || ''))
            lv.style.color = levelColor[e.level] || 'inherit'
            lv.style.background = `${levelColor[e.level] || '#888'}22`
            row.appendChild(lv)
            row.appendChild(mk('span', 'ds', `${e.source ? `[${e.source}] ` : ''}${e.desc || ''}`))
            const detail = mk('span', 'dt', `${e.eventId ? `#${e.eventId} ` : ''}${e.detail || ''}`)
            row.appendChild(detail)
            row.addEventListener('click', () => row.classList.toggle('open'))
            pageLog.appendChild(row)
          }
        }

        renderMeta()
        renderBar()
        setTab('today')
        document.body.appendChild(root)
        mountTopTab()
        refresh()
        void loadState()
        void loadEpisodes()
        const timer = setInterval(refresh, POLL_MS)
        const topTabTimer = setInterval(mountTopTab, 2000)
        const stateTimer = setInterval(loadState, 2000)
        const pageTimer = setInterval(() => {
          if (tab === 'today') void loadEpisodes()
          else if (tab === 'caps') void loadCaps()
          else if (tab === 'cards') void loadCards()
          else if (tab === 'log') void loadLog()
        }, 4000)

        const dispose = () => {
          alive = false
          clearInterval(timer)
          clearInterval(stateTimer)
          clearInterval(pageTimer)
          clearInterval(topTabTimer)
          document.querySelectorAll('[data-dsh-he-tab]').forEach((node) => node.remove())
          document.removeEventListener('click', onTopTabClick, true)
          document.removeEventListener('keydown', onKey)
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
