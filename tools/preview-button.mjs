// 独立预览：把 client.js 放进一个假宿主页面里跑，验证按钮 / 浮层 / 关闭 / 动效。
// 只用于本地看效果，不进产品包。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
// DSH 的 GUI 端口每次启动会变；用环境变量覆盖，默认取当前这次
const port = process.env.HANDEYE_GUI_PORT || '26864'
const live = 'http://127.0.0.1:' + port + '/dsh-handeye-plus/dashboard'

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>HandEye button harness</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d11;color:#fff;font:14px/1.5 "Segoe UI",system-ui,sans-serif}
  .fake{max-width:720px;margin:60px auto;padding:24px;border:1px solid #262c36;border-radius:10px;background:#12161c}
  .fake h1{font-size:18px;margin:0 0 8px}
  .fake p{color:#e9edf3;margin:0 0 8px}
</style></head>
<body>
  <div class="fake">
    <h1>Fake host page</h1>
    <p>This page stands in for DSH: it loads the plugin client same way the host does.</p>
    <p>The HandEye button should sit bottom-right. Click it to open the panel.</p>
  </div>
  <script>
    window.__ModuleLoader__ = { load: (def) => { window.__handeye = def.factory(() => { throw new Error('no modules needed') }); window.__handeye.apply({}) } }
  </script>
  <script>${client.replace(/<\/script>/g, '<\\/script>')}</script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url.startsWith('/dsh-handeye-plus/dashboard')) {
    // 面板还是用真的（跨域没关系，只做展示）
    res.writeHead(302, { location: live })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(page)
})

server.listen(8899, '127.0.0.1', () => console.log('harness on http://127.0.0.1:8899/'))
