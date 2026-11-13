// dsh-handeye — client half（对外叫「手嘴眼」）。
//
// 为什么长这样：DSH 的插件界面不给"往 DOM 里塞按钮"留后路 —— 宿主每次重渲染都会
// 把我们插进去的节点换掉（实测：页签反复消失）。dsh-context 的"上下文"、编队的做法是
// 走官方 slots API 注册一个真正的页签：
//
//   ctx.slots.inject('conversation.view', () => ctx.slots.register({
//     name: 'conversation.view', id, order, label }, Component))
//
// 我们照抄这一条路。页签内容用 iframe 装插件自己的 dashboard —— 一套界面，
// 宿主里一个原生页签，不重复维护。
//
// 旧版那套"右侧竖抽屉 + 6 个页签"已删除：它和宿主的布局打架，且入口反复被覆盖。

window.__ModuleLoader__.load({
  id: 'dsh-handeye',
  factory: (require) => {
    const React = require('react')
    const { jsx } = require('react/jsx-runtime')

    const TAB_ID = 'shouzuian'
    const PANEL_URL = '/dsh-handeye-plus/dashboard'
    const TAB_ORDER = 25

    function Panel() {
      return jsx('div', {
        style: { height: '100%', width: '100%', display: 'flex', minHeight: 0 },
        children: jsx('iframe', {
          src: PANEL_URL,
          title: '手嘴眼控制面板',
          // 填满页签区域；不设固定高度，让宿主的布局决定
          style: { flex: 1, width: '100%', border: 0, minHeight: 0, background: '#0f1115' },
        }),
      })
    }

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        // inject：声明"我要往 conversation.view 里加东西"；回调会在宿主重建时重跑
        ctx.effect(
          () =>
            slots.inject('conversation.view', () =>
              slots.register(
                {
                  name: 'conversation.view',
                  id: TAB_ID,
                  order: TAB_ORDER,
                  label: () => '手嘴眼',
                },
                Panel,
              ),
            ),
          'dsh-handeye: conversation tab',
        )
        return
      }

      // 兜底：宿主版本太老、没有 slots API 时，只留一个极小的入口按钮。
      // 不重建抽屉 —— 那个方案已经被证明会和宿主打架。
      const mount = () => {
        if (!document.body || document.querySelector('[data-dsh-he-fallback]')) return
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.dataset.dshHeFallback = '1'
        btn.textContent = '手嘴眼'
        btn.style.cssText =
          'position:fixed;right:16px;top:52px;z-index:2147483000;font:inherit;font-size:12px;color:#e6e9ee;' +
          'background:#1c2129;border:1px solid #262c36;border-radius:6px;padding:4px 10px;cursor:pointer'
        btn.onclick = () => window.open(PANEL_URL, 'shouzuian-panel', 'width=1440,height=900')
        document.body.appendChild(btn)
      }
      const timer = setInterval(mount, 2000)
      mount()
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => clearInterval(timer), 'dsh-handeye: fallback entry')
      }
    }

    return { apply }
  },
})
