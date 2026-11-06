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
    function apply(ctx) {
      if (typeof document === 'undefined') return

      const install = () => {
        ensureStyle()
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
            手眼 · 活动
            <span class="dsh-he-live"></span>
          </div>
          <div class="dsh-he-sub">AI 最近用这套工具干了什么</div>
          <button class="dsh-he-close" aria-label="收起">×</button>
        `
        const closeBtn = head.querySelector('.dsh-he-close')
        const liveDot = head.querySelector('.dsh-he-live')

        const scroll = document.createElement('div')
        scroll.className = 'dsh-he-scroll'

        const kpis = document.createElement('div')
        kpis.className = 'dsh-he-kpis'

        const distCard = document.createElement('div')
        distCard.className = 'dsh-he-card'

        const failsCard = document.createElement('div')
        failsCard.className = 'dsh-he-card dsh-he-fails'
        failsCard.style.display = 'none'

        const bar = document.createElement('div')
        bar.className = 'dsh-he-bar'

        const list = document.createElement('div')
        list.className = 'dsh-he-list'

        scroll.appendChild(kpis)
        scroll.appendChild(distCard)
        scroll.appendChild(failsCard)
        scroll.appendChild(bar)
        scroll.appendChild(list)

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
          meta.innerHTML = `<span>手眼 <b>v${(m.version || '?')}</b></span><span>·</span>
            <span>handeye <b>${(m.exe || '').split('\\').pop() || '?'}</b></span><span class="grow"></span>
            <span>端口 <b>${m.port || '?'}</b></span>`
        }

        function renderAll(items, meta) {
          data.items = items
          data.meta = meta || data.meta
          renderKpis(items)
          renderDist(items)
          renderFails(items)
          renderRows()

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

        renderBar()
        document.body.appendChild(root)
        refresh()
        const timer = setInterval(refresh, POLL_MS)

        const dispose = () => {
          alive = false
          clearInterval(timer)
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
