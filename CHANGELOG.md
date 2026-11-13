# Changelog

## v0.34.0 — 2026-11-13

**找到客户端一直没生效的真正原因（两个）。**

### 根因 1：少了 `inject: ['slots']`

DSH 的插件文档就在 `app.asar` 里，写得很清楚：

```js
return { inject: ['slots'], apply(ctx) {
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'chat', order: 0, label: () => t('view.chat') }, Component))
}}
```

我们的模块只返回 `{ apply }`，**`ctx.slots` 一直是 undefined**，
注册每次都抛错、退到兜底按钮。用户看到的"HandEye 按钮"从头到尾都是兜底，不是页签。

而且 v0.32.0 我还把 `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-slots` 删了——
那是提供 `slots` 服务的包。两处都补回来了。

### 根因 2：客户端 bundle 是**启动时**打包的，刷新无效

我用探针证明的：把兜底按钮文字改成 `HandEye*`，同步后按 Ctrl+R，
按钮**仍然显示 `HandEye`**。=> 刷新不会重新打包客户端，**必须完全退出 DSH 再打开**。

这也解释了为什么之前每一版"我改了、你没看到"。

### 本次改动

| 项 | 内容 |
|---|---|
| 模块导出 | `{ inject: ['slots'], apply }` |
| 注册 | `conversation.view`（页签，id=handeye，order=25）+ `main`（上下文那种大视图） |
| `dsh.client.inject` | 恢复 `ui-slots` 与 `ui-conversation` |
| 关闭按钮 | 兜底浮层里的 Close 从 30×30 的 × 改成 **96×32 的大按钮**，白字深底，固定在右上角 |
| 测试 | 377 全过（inject 声明、两个槽、大号 Close、无 slots 退兜底） |

### 没能自己验证的部分

我不能重启 DSH——它正是跑这个会话的进程，重启会掐断本次对话。
所以这一版**必须由你重启一次**才能看到效果。重启后请看一眼顶部页签行：
有 `HandEye` 就说明对；没有就说明 `main`/`conversation.view` 之外还得补
`sidebar.panellist` 那三件套。

## v0.33.0 — 2026-11-13

**改成"和上下文一样"：注册在 main 槽，只占会话区，不再全屏。**

### 用户要什么

> Next, it's the same as that context. 只占有这一部分

也就是：HandEye 要像「上下文 / 编队」那样**是会话区里的一个视图**，
不是盖住整个窗口的浮层。

### 怎么做的

照抄 dsh-context（"上下文"页签）的注册方式 —— 它是能用的活样板：

```js
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-handeye', locale }, Panel))
```

- 槽：`main`（不是我们之前猜的 `conversation.view`）
- 键：`key: 'dsh-handeye'`
- 组件：一个填满区域的 iframe（`/dsh-handeye-plus/dashboard?embed=1`）
- 外面包 `ctx.effect`，宿主卸载时能干净退场

### 浮层降级为兜底

只有 `slots` 不可用 / 拿不到 react 时才挂右下角按钮 + 浮层，
并且会 `console.warn` 写明原因。正常情况**不出现**浮动按钮，避免挡视线。

### 测试
377 → **376**（断言改成：注册在 main 槽、key 正确、正常情况没有浮动按钮、
无 slots 时退兜底、无 react 不抛）

## v0.32.2 — 2026-11-13

**修：浮层"没有关闭按钮"；加少量动效。**

### 关闭按钮

用户反馈找不到关闭。原因：Close 按钮原来放在顶栏 flex 里，顶栏被宿主标题栏遮住一截。
改成**独立的固定圆形 ×**：

- `position:fixed; top:10px; right:14px`，自己带 `z-index:2147483003`
- 30×30，悬停变亮 + 放大 6%
- `aria-label="Close panel"`，悬浮提示 `Close panel (Esc)`
- 顶栏提示改成 `Click × or press Esc to return`，不再依赖那个被遮住的按钮

### 少量动效

| 位置 | 动效 |
|---|---|
| 浮层打开 | 淡入 + 从 98.5% 轻微放大（160ms, ease-out） |
| 面板 iframe | 延迟 40ms 淡入（220ms） |
| 浮层关闭 | 淡出 120ms，动画结束再摘 DOM（有 200ms 兜底） |
| 右下角按钮 | hover 上浮 1px + 阴影加深，active 缩到 98% |
| 面板卡片 | 依次淡入 + 上移 5px，6 张卡错开 0–150ms |
| 表格行 / 按钮 / 输入框 | 背景与边框 120ms 过渡 |

**全部尊重 `prefers-reduced-motion: reduce`**：系统开了减少动态效果就一律关掉。

### 测试
375 → **377**（关闭按钮是独立 ×、可访问名、顶栏提示 Esc、卡片动效与 reduced-motion）

## v0.32.0 — 2026-11-13

**把那个没反应的按钮接上了：改成自带浮层，不再赌宿主的页签契约。**

### 问题

用户点右上角的 HandEye 按钮**没有任何反应**。查下来：客户端通过
`ctx.slots.inject('conversation.view', ...)` 注册页签，按钮确实渲染出来了，
但**点了不切换** —— 这个 slots 契约在宿主里没有文档，我们是在猜。

### 改法

放弃页签，改成纯 DOM 的浮层：

- 右下角一个圆角按钮 `HandEye`（fixed 定位，宿主怎么重渲染都不会丢）
- 点它 → 全屏浮层，顶栏 `HandEye | Click Close or press Esc to return | [Close]`
- 浮层里是 `/dsh-handeye-plus/dashboard?embed=1` 的 iframe（还是同一个面板）
- `Close` 按钮或 `Esc` 关闭；重复点击不会叠出第二层
- 全部包 try/catch：拿不到 body、iframe 失败，都只影响按钮，不影响 DSH

### 顺带

- `package.json` 的 `dsh.client.inject` 去掉 `ui-slots` 与 `ui-conversation`（不再需要）
- 客户端不再 `require('react')` —— 少一个可能让宿主起不来的依赖

### 测试
377 → 375（客户端测试重写成假 DOM：按钮存在、点击出浮层、Esc/Close 能关、不重复叠层、坏宿主不抛）

## v0.31.0 — 2026-11-13

**找 bug 一轮：4 个真 bug + 2 处优化。**

### Bug 1 · `@file` 带 BOM 就解析失败（最影响使用）

Windows PowerShell 的 `Set-Content -Encoding UTF8` 默认写 BOM。以前：

```
Failed: arguments must be valid JSON (or @file) - Unexpected token '﻿'
```

用户会以为自己 JSON 写错了。现在读文件后先剥 BOM 再 parse。
**实测**：同一个带 BOM 的文件，修前失败、修后正常返回。

### Bug 2 · `yl_log` 把中文吐给模型

handeye 的日志 JSON 里 `levelName/source/category` 是中文（"信息/会话/感知"）。以前原样返回。
现在 `logReader.formatEvents()` 统一成英文，`desc` 保留原文（那是内容）：

```
2026-11-13 20:57:34.817  Information  Perception  #3012  Perception  OCR 分路统计  [S=7ff08 ...] ms=500
```

### Bug 3 · 记忆锚点把 `hwnd=9` 和引号一起存进去

`hit window: "Chrome" hwnd=9` 以前整串当作容器名。现在只留 `Chrome`。

### Bug 4 · 英文闸门在 Windows 上白名单从不生效

`path.relative` 返回反斜杠，白名单写的是正斜杠 → **永远匹配不上**，
`--strict` 看着失败其实没检查。已修（统一成 `/`），现在 `--strict` 真的通过。

### 优化 1 · CLI 全英文

`bin/he-server.js` 里 ~50 条中文（用法、导入导出、技能草案、领域包）全部英文。

### 优化 2 · 面板删掉死代码

events 已经是英文，`SOURCE_EN`/`CATEGORY_EN` 两张映射表成了死代码，删除。

### CI

英文闸门从"只报告"改成 `--strict` 拦截；白名单包含三类故意保留的中文
（PowerShell 脚本体、中文错误词表、旧前缀兼容）。

### 测试
374 → **377**（新增：formatEvents 中文名映射、空列表、锚点裁 hwnd）

## v0.30.0 — 2026-11-13

**英文化收尾：535 → 31 条，剩下的是三类"故意保留"。**

| 文件 | 之前 | 现在 |
|---|---|---|
| `src/index.js` | 144 | **0** |
| `src/core/verify.js` | 1 | 0 |
| `src/formats/validate.js` | 1 | 0 |
| `src/mcp/server.js` | 1 | 0 |
| `src/tools/voice.js` | 1 | 0 |

### 剩下 31 条是什么

| 类别 | 条数 | 为什么保留 |
|---|---|---|
| 中文错误词表（`text.js` / `project.js`） | 17 | 用来**检测中文文档里的报错**，翻了就认不出来了 |
| `voice.js` 里的 PowerShell 脚本体 | 11 | 是脚本源码，不是输出文案 |
| `LEGACY_FAILURE_MARK` + headless 双读 | 2 | 过渡期兼容：旧中文失败前缀仍被识别 |
| `markers.js` 注释里的旧前缀 | 1 | 文档说明 |

### 判断标准

**"给模型看的、给用户看的"必须英文；"用来识别中文内容的词表"必须留中文。**
这条也写进了 `tools/check-english.mjs` 的注释。

### 测试
374 全过

## v0.29.4 — 2026-11-13

**P0-E1 第五批：技能格式、面板路由、MCP、客户端、记忆与指标层英文化。**

| 文件 | 之前 | 现在 |
|---|---|---|
| `src/skills/skillmd.js` | 32 | **0** |
| `src/api/routes.js` | 8 | **0** |
| `src/mcp/protocol.js` | 7 | **0** |
| `src/client.js` | 7 | **0** |
| `src/memory/anchor.js` | 5 | **0** |
| `src/memory/skills.js` | 5 | **0** |
| `src/runtime/logReader.js` | 5 | **0** |
| `src/core/metrics.js` | 4 | **0** |
| `src/packs/loader.js` | 3 | **0** |
| `src/server/headless.js` | 3 | **0** |

### 闸门数字

```
535 → 466 → 405 → 355 → 321 → 260 → 206 → 182
```

### 说明

- `anchor.js` 解析窗口名用的正则跟着 winui 的输出改成了 `hit window:`；
  测试样例输出同步改了（否则容器名解析为空）
- 面板标题、页签标签彻底变成 `HandEye`

### 测试
374 全过

## v0.29.3 — 2026-11-13

**P0-E1 第四批：屏幕投影 / 窗口 / 浏览器 / 打包层英文化。**

| 文件 | 之前 | 现在 |
|---|---|---|
| `src/browser.js` | 20 | **0** |
| `src/project.js` | 20 | 9（只剩"中文错误词"词表，是检测中文文档用的，故意保留） |
| `src/winui.js` | 17 | **0** |
| `src/data/bundle.js` | 13 | **0** |
| `src/desk.js` | 12 | **0** |
| `src/handeye.js` | 12 | **0** |
| `src/eye.js` | 9 | **0** |
| `src/text.js` | 9 | 8（同上，中英双语词表） |

### 抓到一个真 bug（自己改出来的）

把报警前缀从 `[报警]` 换成 `[alarm]` 后，`project.js` 里 `truncateLines` 的
`isAlarm = (l) => l.startsWith('[报警]')` **没跟着改** —— 结果报警行在超预算时会被当普通行丢掉。
测试先红了（"报警行永远不丢"），才发现。

教训：**前缀既是显示文本又是内部判据**，改文案时必须搜一遍同名前缀的所有使用点。

### 闸门数字

```
535 → 466 → 405 → 355 → 321 → 260
```

剩余主要是 `src/index.js`（144 条，工具实现）与 `skillmd.js`（32 条）。

### 测试
374 全过

## v0.29.2 — 2026-11-13

**P0-E1 第三批：目标层与事件层英文化。**

| 文件 | 之前 | 现在 | 内容 |
|---|---|---|---|
| `src/tools/goals.js` | 64 | **0** | 建/规划/状态/进入/完成/续预算/跳过/改状态全部文案 |
| `src/core/events.js` | 50 | **0** | 级别名、来源名、类别名、事件描述与消息 |

### 闸门数字

```
535 基线 → 466 → 405 → 355
```

**工具层（tools/）现在只剩 1 条**（`goals` 的残留已清），模型的输出路径基本英文了。

### 顺带修

- 测试里从输出提取 goal id 的正则（`/已建目标 (goal_\S+)：/` → `/Goal (goal_\S+) created:/`）——
  文案一改，这类"从文本里抠 id"的断言是第一个挂的，值得记一笔

### 测试
374 全过

## v0.29.1 — 2026-11-13

**P0-E1 第二批：教程与技能工具英文化（模型直接读的两个）。**

| 文件 | 条数 | 内容 |
|---|---|---|
| `src/tools/tutorials.js` | 41 → 0 | 列表/详情/开始、缺参数、判据描述 |
| `src/tools/skills.js` | 18 → 0 | 编译成目标、缺参数、健康度 |
| `src/tools/voice.js` | 8 → 0 | 语音清单与失败提示 |
| `src/tools/goals.js` | 2 行 | 健康度 +1 的两条提示（其余 64 条留到下一批） |
| `src/server/toolServer.js` | 1 → 0 | 未知工具提示 |

### 闸门数字

```
v0.29.0 基线: 535 条 / 31 个文件
现在:        466 条 / 28 个文件   （语音+教程+技能三个文件清零）
```

### 测试
374 全过；教程与技能测试断言同步改英文；
`toolServer` 里保留一条**双读**用例：旧 `失败：` 前缀仍被识别（过渡期保障）。

## v0.29.0 — 2026-11-13

**P0-E1 开工：失败标记常量化 + 首批英文化 + 英文闸门 + CI。**

### 做了什么

| 代号 | 内容 |
|---|---|
| **E1-01** | 新建 `src/core/markers.js`：`FAILURE_MARK = 'Failed: '` + **旧前缀双读**，`toolServer` 改用 `isFailure()`。这样 535 条可以逐文件翻，漏一处也不会让门卫认不出失败 |
| **E1-02（部分）** | `src/tools/util.js`（失败前缀切英文，全工具共享）、`src/tools/meta.js`（9 处） |
| **E1-03** | `src/core/verify.js` 26 处：判据的"期望/实际"、通过/失败摘要全部英文 |
| **P0-P1** | `.github/workflows/test.yml`：Windows + Node 22，`node --test`；英文闸门先只报告不拦截 |
| 工具 | `tools/check-english.mjs`：扫字符串字面量里的中文（跳过注释与正则），给出**准确进度** |

### 基线（可验证）

```
$ node tools/check-english.mjs
合计 535 条（31 个文件）
  index.js 144 · tools/goals 66 · core/events 50 · tools/tutorials 41 · skills/skillmd 32 …
```

这个数字会随着每批翻译下降，直到 0 —— 比"我觉得翻完了"可靠。

### 测试
374 全过（断言随文案同步改成英文）

## v0.28.0 — 2026-11-13

**范围收敛：只做英文。**

上一版试过"英文默认 + 中文模式"，按用户决定改成**只提供英文**：

- 删除语言选择器（`id="lang"`）与整张中文词表（`ZH`）
- 删除 `applyLang()` / MutationObserver 翻译层
- `<html lang="en">`
- **保留字号调节**（A- / A / A+，仍存 localStorage）

### 为什么

国际化 = 英文一种。不做多语言切换，也就不需要 RTL、文案膨胀预留、
德语/俄语长度适配这些成本——**范围小，能做深**。

### 测试
374 全过（删掉过期的"中文模式"用例，新增"只提供英文、没有语言选择器"）

## v0.27.1 — 2026-11-13

**修面板里的三个真 bug。**

| # | bug | 修法 |
|---|---|---|
| 1 | 待确认弹窗里参数显示 `[object Object]` | `String(obj)` 改成 JSON 序列化（字符串原样，对象 JSON，失败给 `(unserializable)`），截断 200 字符 |
| 2 | 计数没有单复数：`1 skills` / `1 events` | 加 `plural(n, one, many)`，事件/技能/能力/卡片/教程/动作全部走它 |
| 3 | 耗时统计漏算没有 `ms` 字段的动作 | 改成统计**所有** 4001/4002 动作，缺 ms 按 0 计（以前只统计 detail 里有 `ms=` 的） |

### 测试
371 → **374**（单复数护栏、参数序列化护栏、耗时统计口径护栏）

## v0.27.0 — 2026-11-13

**国际化：英文默认，中文模式可切，字号可调。**

### 新增

- 顶栏 **EN / 中文** 切换（`localStorage: he.lang`，默认 en）
- 顶栏 **A- / A / A+** 字号（`localStorage: he.size`，CSS zoom）
- 中文模式：源码本身就是英文，切到中文时用一张 en→zh 词典对渲染结果做替换，
  每次渲染后与 DOM 变化后（MutationObserver，120ms 防抖）再补一次
- 切回英文走 reload（英文是源码语言，最可靠）

### 说明

- 覆盖范围：卡片名、表头、按钮、空状态、级别名、来源名、教程弹窗
- 用户数据（目标标题、技能名、日志正文）不翻译——那是内容，不是界面
- 中文模式下动态刷新靠 DOM 翻译，个别异步渲染可能漏翻；有词典条目就能补

### 测试
369 → **371**（面板默认英文、有中文模式、字号可调）

## v0.26.1 — 2026-11-13

**修 v0.26.0 里的一条误报测试。**

面板护栏把"中文 → 英文"的映射表也当成可见中文（SOURCE_EN / CATEGORY_EN 的条目），
导致 369 条里挂 1 条。修法：检查前先剥掉 `'中文': 'English'` 这类映射对。

（这条同时也说明：v0.26.0 我是**先提交后才发现红**——以后发版脚本里必须先跑测试再提交。）

### 测试
369 全过

## v0.26.0 — 2026-11-13

**面板全英文 + 亮白文字（为国际化做准备）。**

### 改了什么

- **所有界面文字改成英文**：标题、卡片名、表头、按钮、空状态、教程、提示语
- **正文颜色改成亮白**：`--text: #ffffff`、`--muted: #e9edf3`、`--dim: #d5dbe4`，
  表头/标题/标签一律纯白，层级只靠字号与字重区分
- **数据层也翻译**：服务端事件里的 `source`（手眼/浏览器/目标…）和 `category`（动作/门卫…）
  仍是中文数据，界面加了一层映射：
  - `sourceText()`：手眼→Hands、浏览器→Browser、后台控件→Backend、目标→Goals、卡片→Cards、技能→Skills、门卫→Gate
  - `categoryText()`：动作→Action、门卫→Gate、目标→Goal、技能→Skill
  - `levelText()`：1 Critical / 2 Error / 3 Warning / 4 Information / 5 Verbose
  级别与类别一律按事件里的数字渲染，不再直接用服务端的中文文本

### 校验

- 面板文件里可见文字**零中文**（注释不算），有单测守着
- JS 语法检查通过；369 条单测全过

### 说明

消息正文（goal 标题、日志描述）仍是用户数据，可能是中文——那是内容，不是界面。

### 测试
369 条（面板护栏改为：必须英文、必须有 #ffffff、不许有可见中文）

## v0.25.1 — 2026-11-13

**修：教程卡打开时是空的。**

v0.25.0 的 `loadTutorials()` 写好了，但**启动时没调用**——只有点了"保存/运行"才会刷新。
所以面板上永远显示"还没有教程"，而 `/tutorials` 接口其实有 19 条。

修法：启动时 `void loadTutorials()`，并加入 10 秒轮询。

### 实测（跑在真实数据上）

```
教程  19 份
安全审查      4 步 · —      0 次 · 成功 0   untested  [运行] [编辑]
代码仓库体检  4 步 · —      0 次 · 成功 0   untested  [运行] [编辑]
发票整理      4 步 · 1 条   0 次 · 成功 0   untested  [运行] [编辑]
...
```

### 测试
368 → **369**

## v0.25.0 — 2026-11-13

**教程层：用户写步骤，AI 照着做。**

### 为什么

用户指出："我们插件有一个很有用的地方，就是允许用户给 AI 写教程，让 AI 照着这个教程。"
查证后确认：**卡片有 `path`/`constraints`/`success`/`verify`，但模型看不到、也跑不了**，
旧抽屉的"发送到对话"按钮删掉后这条路彻底断了。

### 新增

- **3 个工具**
  - `tutorial_list`：列出所有教程（步骤数、判据数、跑了多少次）
  - `tutorial_get <id>`：读全文（目标 / 步骤 / 约束 / 成功标准 / 判据）
  - `tutorial_start <id> [params]`：**编译成目标**（步骤来自 path，判据挂在最后一步）
- **教程健康度**：卡片新增 `health`（runs / ok / fail / failsInRow / status）
  - 跑完最后一步 → `recordRun(success)`
  - 步骤被锁 → `recordRun(failure)`
- **HTTP 路由**：`GET /tutorials`、`POST /tutorials/save`、`POST /tutorials/run`
  - 面板按钮和模型调工具走**同一条路**（共享 `startTutorial()`）
- **面板新增"教程"卡**：列表（步骤/判据/跑过/状态）、**写教程表单**（标题/目标/步骤/约束/判据）、
  运行、编辑

### 与技能的关系

同一条执行通道：教程是"人写的"，技能是"从操作里编译的"，都编译成目标、都过门卫、都记健康度。

### 顺手修的 bug

- `/state` 500：v0.24.0 用了 `FORMATS_VERSION` 但**没 import**。语法检查查不出，只有真调路由才炸。
  现在有 `test/api/routes.test.mjs`：把每条 GET 路由真跑一遍。
- 卡片健康度状态写错：跑 1 次失败也算 healthy → 改成"失败过且成功率 <90% 就不是 healthy"。

### 测试
354 → **368**（教程工具 9 条、路由 5 条、面板 1 条）

## v0.24.2 — 2026-11-13

**事故修复：客户端入口抛错会让 DSH 起不来。**

### 事故（有崩溃日志）

```
C:\Users\Administrator\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\
  crash-2026-11-13T12-39-31-308Z-web-boot.log
  crash-2026-11-13T12-39-38-566Z-web-boot.log

--- error ---
Error: web boot: 1 entry did not activate
dsh-handeye: failed
```

两次启动都是同一个原因。时间点（20:39:31/38）对应插件目录里的 **v0.23.1**。

那个版本的客户端在 factory 顶层直接 `require('react')` / `require('react/jsx-runtime')`，
任何一步失败都会让 factory 抛错 → 宿主把它算成 "web boot: 1 entry did not activate" →
**这个错误是致命的**，DSH 整个起不来，用户只能把全部第三方插件禁掉。

### 修法（三层，缺一不可）

1. **模块加载层**：`window.__ModuleLoader__.load(...)` 包 try/catch；ModuleLoader 不在就跳过
2. **factory 内**：require 包 try/catch（v0.24.1 已做）
3. **apply**：整体 try/catch，失败只降级到兜底入口（v0.24.1 已做）

失败时打 `console.warn('[handeye] ...')`，下一次崩溃日志里能直接看到原因。

### 教训（已写进 AGENTS）

DSH 的插件树里，**web entry 激活失败是致命错误**，不是"这个插件不显示"。
客户端插件必须假设自己随时会失败，且**任何异常都不许冒泡到宿主**。

### 测试
353 → **354**（加载层不抛、ModuleLoader 缺失时整体跳过）

## v0.24.1 — 2026-11-13

**客户端加固：任何异常都不许拖垮宿主。**

用户重启后出现故障，不得不禁用全部第三方插件。虽然不能证明是本插件引起的，
但 v0.23 的客户端有两个真实的抛错点：

1. `require('react')` 在 factory 顶层 —— 宿主没给就会在**加载阶段**抛
2. `slots.register(...)` 没有 try/catch —— 形状不对就冒泡到宿主

修法：

- `require` 包在 try/catch 里，拿不到 React 就退到"新窗口打开面板"的兜底按钮
- `apply()` 整体 try/catch，登记失败只让本插件入口消失，**永不抛给宿主**
- 没有 `ctx.effect` 时直接登记（不自作主张）
- 去掉 2 秒轮询的兜底入口（那个定时器也是风险）

### 测试
351 → **354**（新增 3 条：apply 永不抛、缺 react 不在加载期炸、坏 slots 只降级）

## v0.24.0 — 2026-11-13

**面板照 dsh-context 的卡片布局重排，系统日志改成整宽大表。**

### 布局（照 dsh-context）

```
┌ header：手嘴眼 vX · 状态 · 时间范围 · 教程 · 刷新 ────────────────┐
├ 执行统计（4 KPI + 工具调用 / 执行来源 / 被拦原因 / 动作结果）      ├ 插件信息
├ 系统日志（整宽大表，最高 472px，6 列 + 级别/来源/搜索）           ├ 技能
├ 当前目标（进度 + 步骤）        │ 事件级别分布（环 + 图例）        │
├ 耗时统计（环 + 时间轴）        │ 能力（表）                       │
└ 任务卡（整宽，紧凑）                                             ┘
```

### 系统日志为什么变大

用户原话："系统日志写大一点，这个系统日志占的太小了。" 之前它和"当前目标"挤在
半格里、最高 212px。现在：

- **整宽**，最高 **472px**
- 6 列全显示：级别 / 日期和时间 / 来源 / 事件 ID / 任务类别 / 描述
- 自带级别筛选、来源筛选、搜索框
- 想更大就点"导出 / 打开全部"（弹窗里是完整表 + 详情 + CSV）

### 其它

- `/state` 补 `version` / `dataDir` / `formatsVersion`，插件信息卡不再摆一排破折号（拿不到就隐藏该行）
- 事件加 `tool` 字段；旧事件没有时从 `detail` 的 `tool=` 里回退解析
- 图例支持"字符串值"（如 `8.8s`），不再出现 `NaN%`
- `/goals` 回的是 `{ goals }` 不是 `{ value }`，已兼容

### 测试
349 → **351**

## v0.23.1 — 2026-11-13

**修：客户端插件的依赖清单写错了。**

v0.23.0 里我照着 dsh-context 抄了 inject 列表，但抄错了包：

| 写的是 | 实际需要 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-api-remotes` | — | 那是 dsh-context 自己用的远端 API |
| `@deepseek-ai/dsh-client-connection` | — | 同上 |
| — | **`@deepseek-ai/dsh-client-ui-slots`** | **slots 是独立包，漏了它就拿不到 ctx.slots** |
| `@deepseek-ai/dsh-client-ui-conversation` | 同 | tab 槽在会话 UI 包里 |

对照 `dsh-better-sidebar`（同样用 require react + slots）后修正为：

```json
"inject": [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-modules"
]
```

### 测试
349 → **351**（清单护栏：必须有 ui-slots，不许再出现 api-remotes）

## v0.23.0 — 2026-11-13

**客户端重写：走官方 slots API 注册原生页签，旧抽屉整段删除。**

### 为什么删

旧版往 DOM 里塞按钮/抽屉，宿主每次重渲染都会覆盖或删掉它（实测：页签反复消失、
小圆眼挂上后顶部页签被自己的代码删掉）。这条路走不通。

挖了 dsh-context 的实现，确认官方做法是 **`ctx.slots`**：

| 槽 | 谁在用 | 作用 |
|---|---|---|
| `conversation.view` | **编队** | 会话顶部的一个页签 |
| `main` | **上下文** | 整页主视图 |
| `sidebar.panellist` | 上下文 | 右侧栏里的一个面板 |
| `conversation.input.overlay` | — | 输入框浮层 |

### 现在

```js
ctx.slots.inject('conversation.view', () =>
  ctx.slots.register({ name: 'conversation.view', id: 'shouzuian', order: 25, label: () => '手嘴眼' }, Panel))
```

- 页签是宿主自己渲染的，重渲染不会丢
- `Panel` 是一个 iframe，装插件自己的 `/dsh-handeye-plus/dashboard`
- 旧抽屉（6 页签、KPI/分布/时间线那一套 DOM 注入）**全部删除**，client.js 从 1780 行降到 96 行
- 宿主没有 slots API 时只留一个极小入口按钮（不重建抽屉）

### 测试
344 → **349**（新增 client-slot 7 条：模块 id、require react、注册哪个槽、id/order/label、
iframe 地址、effect 包装、旧抽屉不再出现）

## v0.22.1 — 2026-11-13

**修：会话里看不到顶部页签。**

### 根因

`mountEntry()` 里写的是"输入框旁边的小圆眼挂成功，就把顶部页签删掉"：

```js
if (mountComposerEntry()) {
  document.querySelectorAll('[data-dsh-he-tab]').forEach((n) => n.remove())  // ← 删页签
  return
}
```

以前小圆眼挂不上（找不到输入框），才退到顶部页签；这一版小圆眼挂上了，
**页签就被主动删掉** —— 用户想要的"和上下文、编队同一排"的入口反而没了。

### 修法

入口优先级反转：**顶部页签优先**，页签在时收掉小圆眼；页签挂不上才退回小圆眼。

### 测试
343 → **344**（回归：mountEntry 必须先试页签，且不许删页签）

## v0.22.0 — 2026-11-13

**改叫法 + 修问题 + 面板变成 DSH 里的一等视图。**

### 叫法：对外叫「手嘴眼」，标识符一个没动

它现在有嘴（`voice_say`），叫"手眼"少了一半。按约定：

- **改**：面板标题、顶部页签、抽屉标题、README 标题、教程文案
- **不改**：包名 `dsh-handeye`、工具名（`hand_*` / `eye_*` / `voice_*`）、数据目录、仓库名

理由：工具名一改，**已有技能和卡片全部失效**（记录里存的是旧工具名）；包名一改，已装用户的路径全废。
别名可以随便改，标识符改一次付一次代价。

### 面板：从浏览器页面变成 DSH 里的整页视图

- 点顶部 **手嘴眼** 页签 → 在 DSH 窗口内整页打开（`openBigView`，iframe 装同一份 dashboard）
- Esc 或右上角"关闭"收起；卸载时清理节点与监听
- 抽屉保留，作为"快速看一眼"的入口（确认按钮也在抽屉里）
- 不再需要单独开浏览器窗口

### 面板内容：五个页签

| 页签 | 内容 |
|---|---|
| 总览 | KPI（6 项）、**待确认（破坏性动作）**、目标与步骤、技能健康度、来源分布、最近动作 |
| 系统日志 | Windows 事件查看器式大表 + 级别/来源筛选 + 搜索 + 导出 CSV |
| 能力 | 名称、状态、风险、运行次数、成功率、说明 |
| 任务卡 | 卡片、类别、自主度、步骤数、来源 |
| **教程** | 加技能 / 加任务卡 / 装领域包 / 带走数据 / 门卫拦住了怎么办 / 日志怎么看 |

### 修掉的三个问题

1. **KPI 第六格被挤掉** → 改成 `auto-fit minmax(120px, 1fr)`，窄窗口自动换行
2. **技能事件时间偏旧**（用的是创建时间）→ 改用 `health.lastRunAt`，没有才退回创建时间
3. **能力页/任务卡页/确认入口只在抽屉里** → 全部搬进大面板

### 测试
337 → **343**（界面结构护栏 6 条：叫法、五个页签、日志列、大面板、Esc 清理、确认区）

## v0.21.0 — 2026-11-13

**重做界面 + 重做系统日志。** 从"竖着的抽屉"变成整页宽屏面板；日志从"没用的 C++ 日志"变成执行事件日志。

### 为什么重做日志

原来面板的"日志"读的是 **handeye 的 C++ 日志**（OCR 引擎、点击命中这些内部细节）。
它回答不了"AI 干了什么、被拦了几次"——所以看起来没用。

新的 **事件日志**（`src/core/events.js`）把执行记录整理成 Windows 事件查看器的形状：

| 级别 | 日期和时间 | 来源 | 事件 ID | 任务类别 | 描述 |
|---|---|---|---|---|---|
| 警告 | 11-13 21:01:22 | 门卫 | 2001 | 门卫 | 拒绝 hand_type：GOAL_STEP_REQUIRED |
| 错误 | 11-13 21:01:23 | 浏览器 | 4002 | 动作 | browser_tabs 失败：fetch failed |
| 信息 | 11-13 21:01:24 | 手眼 | 4001 | 动作 | hand_click_text：点击了「订阅」 |

- 级别照 Windows 五档：1 严重 / 2 错误 / 3 警告 / 4 信息 / 5 详细
- 事件 ID 分段：2xxx 门卫、3xxx 目标、4xxx 动作、5xxx 技能
- 支持：级别筛选（含"该级别及以上"）、来源筛选、搜索、点行看详细信息、**导出 CSV**
- step 没有自己的时间戳，用 episode 起点 + 累计耗时推算（顺序真实，误差毫秒级）

### 新的大面板（`/dsh-handeye-plus/dashboard`）

整页宽屏，不再是一条竖抽屉：

```
┌ KPI：动作 / 失败 / 门卫拒绝 / 警告 / 进行中目标 / 技能 ────────────────┐
├ 系统日志（事件查看器式大表，占满宽度，可筛选/搜索/导出）──────────────┤
├ 目标与步骤（进度条 + 每步状态 + 被锁原因） │ 技能健康度（用了/成功/失败/成功率）┤
└ 事件来源分布（条形）                       │ 最近动作（滚动列表）        ┘
```

- 新增路由：`/dsh-handeye-plus/dashboard`（HTML）、`/dsh-handeye-plus/events`（JSON）、`/dsh-handeye-plus/skills`
- 面板每 10 秒自动刷新，标签页在后台时不刷
- 抽屉里的"日志"页也换成了事件列表，顶部有 **打开大面板** 按钮

### 测试
324 → **337**（事件映射 13 条：级别、事件 ID、拒绝识别、来源归类、目标/技能事件、过滤、统计）

## v0.20.0 — 2026-11-13

**S4 · 在别的客户端里也能确认了。** 破坏性动作不再只能"拒绝"。

### 新增

- **MCP elicitation（协议级确认）**：门卫返回 `Refused: CONFIRM_REQUIRED` 时，
  服务端向宿主发 `elicitation/create`；用户点"允许"才写一次性授权并**重试一次**
  - 客户端没声明 `elicitation` 能力 → 保持原来的行为（直接拒绝），不弹窗
  - 客户端拒绝 → 不执行，返回"用户拒绝了这个动作。"
  - 宿主弹窗失败 → 回一句"请在本机执行 `node bin/he-server.js confirm <工具>`"
- **`confirm` 命令**：给"没有面板也没有 elicitation"的场景补一条本地确认通道
- **一次性授权落盘**（`grant-once.json`）：CLI 的 `confirm` 与真正调用通常在不同进程，
  只放内存里等于白授权

### 修的两个真 bug（都是端到端才暴露）

1. **死锁**：服务端发 elicitation 后等宿主回包，而回包被排进了同一条串行队列 ——
   自己等自己，永远不出结果。修法：**回包先于队列处理**。
   单测（直接调 handler）发现不了，只有起真进程才看得见。
2. **一次授权被用两次**：内存里用掉时没删盘上的票，下一个进程白捡一次。
   修法：内存消费同时删文件。

### 实测（真进程、真握手）

```
initialize -> handeye v0.20.0
tools/list -> 51 个工具
宿主收到确认请求：AI 想执行「browser_navigate」，这看起来是破坏性操作。要允许这一次吗？
tools/call 最终返回 isError=true
  内容：browser_navigate 失败：fetch failed
  是门卫拒绝吗：false
  确认流程走通（拿到一次性授权后重试过）吗：true
```

注意最后一行：返回的是**工具自己的失败**，不是门卫拒绝 —— 说明确认之后真的执行了。

### 测试
317 → **324**（协议层 4 条 + 真进程 e2e 3 条：确认后重试、拒绝不执行、无能力时直接拒）

## v0.19.2 — 2026-11-13

**声音出口。** AI 现在能说话了（也能把话合成成 WAV）。

### 新增

- **`voice_say`**：`handeye say` 优先，不行自动退到 Windows `System.Speech`
  - 参数：`text`（≤300 字）/ `voice` / `rate`(-10..10) / `volume`(0..100) / `wav`
  - 文本走**临时文件**传递，中文、引号、换行都不会被命令行吃掉
- **`voice_list`**：列可用语音（handeye 起不来就退到 PowerShell 清单）
- 风险分类：`voice_say` 算写（会出声），`voice_list` 算读

### 为什么要有两条通道

这台机器上 `handeye say` 直接失败：

```
$ handeye say "语音通道测试"
ERR 语音合成失败: Internal Speech Error.
```

而 `System.Speech` 能看到并使用 Huihui / Zira / Hazel。所以做成"优先原生、失败降级"，
并且失败时**如实说走了哪条通道**，不假装是同一件事。

### 实测

```
$ node bin/he-server.js call voice_list
可用语音（System.Speech）：
Microsoft Huihui Desktop / zh-CN
Microsoft Zira Desktop / en-US
Microsoft Hazel Desktop / en-GB

$ node bin/he-server.js call voice_say @args.json      # text=语音通道已接入 volume=70
已播报（System.Speech）：「语音通道已接入」（通道：system-speech）

$ node bin/he-server.js call voice_say @wav.json       # 合成到 WAV
已合成到 ...\he-voice-test.wav：「任务完成，报告已生成。」（通道：system-speech）
WAV: 147.7 KB
```

### 摄像头与麦克风（这次没做，说明理由）

- **摄像头**：`handeye.exe` 没有这个命令；当年是 PowerShell + WinRT `MediaCapture`
  单独做的（要 IAsyncInfo COM 轮询、文件须预建、无独立照片流）。隐私成本高
  （取景不可控，可能拍到人/证件），要做就必须配"每次调用都要人点一次允许"。
- **麦克风**：模型听不了音频，录了没用；纯增风险，不做。

### 测试
307 → **317**（参数校验、通道选择、双通道失败如实报错、WAV 空文件识别、工具层短路）

## v0.19.1 — 2026-11-13

**S3 · 打包与恢复。** 把"归你"变成能点的按钮。

### 新增

- **`src/data/bundle.js`**
  - `exportBundle({ dataDir, includeLogs })`：技能 / 目标 / 卡片打成一个 JSON（可选带 episode 日志）
    - 打包前**逐个校验**：坏数据不进 bundle，只给警告
  - `importBundle({ dataDir, bundle, dryRun, force })`：
    - **先全部校验，再落盘**：坏文件一个都不写
    - 默认**不覆盖**：已存在的标记 `skip` 并报告；`--force` 才覆盖
    - `--dry-run` **零副作用**（连目录都不建 —— 这是修过的一个 bug：最初实现会顺手建空目录）
    - 日志文件名做白名单校验（`[\w.-]+\.jsonl`），挡掉 `../evil.jsonl`
- **CLI**
  ```bash
  node bin/he-server.js export <文件> [--include-logs]
  node bin/he-server.js import <文件> [--dry-run] [--force]
  ```

### 实测（真实数据）

```
$ node bin/he-server.js export %TEMP%\handeye-bundle.json
已打包 -> ...\handeye-bundle.json
  技能 1 · 目标 1 · 卡片 19
文件大小: 28 KB

$ node bin/he-server.js import %TEMP%\handeye-bundle.json --dry-run
导入计划（预演，没有写盘）：
  技能 新增 0 · 跳过 1 · 覆盖 0
  目标 新增 0 · 跳过 1 · 覆盖 0
  卡片 新增 0 · 跳过 19 · 覆盖 0

$ node bin/he-server.js import bad-bundle.json
失败：这次导入没有改动任何数据
  - 技能 broken：schemaVersion is required；title is required；…
exit=1
```

### 说明

- `preferences` 字段留了但现在是空的：偏好还没有独立存储，等有了再填，不假装有
- 恢复的卡片 `origin` 会变成 `imported`（存储层的行为），内容不改

### 测试
297 → **307**（空目录、三类数据、坏文件跳过、日志可选、版本校验、整目录往返、坏包不动盘、跳过/覆盖、dry-run 零副作用、日志文件名安全）

## v0.19.0 — 2026-11-13

**S2 · SKILL.md 互操作。** 我们的技能现在能变成行业标准格式，也能读别人的。

### 依据

[Agent Skills 规范](https://agentskills.io/specification)：一个技能 = 一个目录，
必须有 `SKILL.md`（YAML frontmatter + Markdown），必填 `name`（≤64，小写字母数字连字符）与
`description`（≤1024），可选 `license` / `compatibility` / `metadata` / `allowed-tools`。

### 新增

- **`src/skills/skillmd.js`**
  - `exportSkillMarkdown(skill)`：内部 JSON → `SKILL.md` + `scripts/`
    - 正文写给人看（步骤、判据、注意事项），**再附一段机器可读 JSON** 供我们回读
    - 判据里引用的本地 `.mjs` 会被复制进 `scripts/`
  - `importSkillMarkdown(text)`：优先读机器可读段（往返无损）；
    没有那段的"外来" SKILL.md 会退化成"照说明执行"的单步技能，并**明说判据为空**
  - 极简 frontmatter 解析器（只认 `key: value` 与一层 map，零依赖）
  - `slugify()`：中文标题转不出合法 name 时回落到 id，保证符合规范
- **CLI**：`skill export <id> --to <目录>` / `skill import <目录>`

### 实测

```
$ node bin/he-server.js skill export skill_20261108_02 --to %TEMP%\skillmd-out
已导出「系统状态巡检」-> ...\skillmd-out
  name: skill-20261108-02
  SKILL.md

$ node bin/he-server.js skill import %TEMP%\skillmd-in
已导入「系统状态巡检」-> skill_20261113_77（1 步）
```

导出的 `SKILL.md`：

```yaml
---
name: "skill-20261108-02"
description: "系统状态巡检（1 步）；由手眼插件的操作记录编译而来，按步骤执行即可。"
license: "MIT"
compatibility: "Windows；需要 Node ≥ 20；桌面自动化需要前台窗口权限"
metadata:
  handeye.id: "skill_20261108_02"
  handeye.version: "1"
---
```

### 取舍说明

- **不承诺"和任意客户端双向无损"**：机器可读段只有我们读；别人读正文。
  外来 SKILL.md 没有判据，我们**照实标空**，不假装能验。
- **scripts/ 只带判据里引用到的脚本**，不带整个项目。

### 测试
287 → **297**（Slug 规范、frontmatter 必填、正文可读性、脚本打包、往返无损、外来技能降级、坏 JSON 段降级）

## v0.18.0 — 2026-11-13

**S1 · 技能闭环。** 从"能存"到"能用"，并且用完会记账。

### 新增

- **`skill_use <id> [params]`**：读技能 → 参数替换 → **编译成一份目标** → 交给目标层跑
  - 决定：**不另起执行器**。目标层已有步骤门/预算/判据/blocked/留痕，再造一套并行状态机
    就会第二次出现"门卫只有一半"的问题
  - 必填参数缺失 → 直接拒，不猜、不留空占位符
  - 技能步骤的 `expect` 原样变成目标步骤的 `verify`
- **`skill_health [id]`**：runs / ok / fail / status / 上次失败原因
- **健康度回写**：目标跑完最后一步 → `recordRun(success)`；步骤被 blocked → `recordRun(failure, reason)`
- `goal.create()` 支持 `meta`（记录技能来源），目标文件里能追到"这是哪份技能跑出来的"

### 修复 / 改进

- **CLI 支持 `@文件` 传参**：`node bin/he-server.js call skill_use @args.json`
  Windows 上 PowerShell 会吃掉内层双引号，以前传 JSON 必须手写转义

### 已知限制

- **CLI 每次调用都是新进程**，状态不跨进程：`goal_step_enter` 之后再用另一条 CLI 命令
  `goal_step_done` 是无效的（状态机在内存里）。要走流程要么单进程（工具/MCP），
  要么等以后的常驻守护进程（M6）

### 实测（单进程）

```
① 已用技能「打开订阅页」建立目标 goal_20261113_461e45（1 步）
② ✓ 完成 s1：打开 https://a.example
   技能健康度 +1：skill_20261113_01
③ skill_20261113_01  打开订阅页
   用了 1 次 · 成功 1 · 失败 0 · 状态 healthy
```

### 测试
278 → **287**（参数替换、缺参拒绝、未知技能、编译成目标、成功回写、失败回写、健康度展示）

## v0.17.0 — 2026-11-08

**M5 · 第一个领域包（会计）。** 核心不动，行业知识以"包"的形式装进来。

### 新增

- **格式仓 `packs/accounting`**（formats v1.1.0）
  - 3 张卡片：发票整理 / 银行流水对账 / 月度汇总
  - 2 条判据模板，其中"合计一致"是**真会跑的脚本**（`checks/total.mjs`）
  - 选会计的理由：判据天生机器可验（金额、笔数、合计），错了能改，风险低
- **`src/packs/loader.js`**：领域包加载器
  - `loadPack()` 先过格式校验，不合格整包不装
  - `installPack()` 装进本地卡片库；`{{packCheck:xxx}}` 替换成包内脚本真实路径
  - 重复安装报告冲突，不静默覆盖
- **CLI**：`node bin/he-server.js pack validate|install <目录>`

### 实测

```
$ node bin/he-server.js pack validate <...>\packs\accounting
通过：accounting v0.1.0 · 3 张卡片 · 2 条判据模板

$ node bin/he-server.js pack install <...>\packs\accounting
领域包 accounting v0.1.0：装了 3 张卡片，0 张失败
  ✓ invoice_tidy  发票整理
  ✓ bank_reconcile  银行流水对账
  ✓ monthly_summary  月度汇总

$ node ...\checks\total.mjs ...\invoices.csv --total 7244.50 --count 4 --amount-col 2
通过：4 笔，合计 7244.50（列「金额」）
```

### 过程中修的一个真 bug

CSV 解析没处理引号：`"￥1,200.00"` 被逗号切成两格，合计从 1288 变成 89。
真实会计表里这种写法到处都是，现在按引号状态解析，并补了测试（BOM、货币符号、非数字行）。

### 还没做

- 还没有真实用户跑两周（这是 M5 的**验收标准**，目前只验证了工具链）
- 面板里没有"领域包"页（现在用 CLI 装）
- 包只装卡片，技能模板还没接

### 测试
272 → **278**（加载器 6 条：校验、拒绝、缺文件、占位替换、安装、重复安装）

## v0.16.0 — 2026-11-08

**M4 · 格式独立成仓。** 产品会被抄，格式会被继承。

### 新增

- **独立仓 `dsh-handeye-formats`**（`D:\Huawei\projects\dsh-handeye-formats`，v1.0.1）
  - `schemas/skill.schema.json` / `verify.schema.json` / `domain-pack.schema.json`
  - `lib/validate.mjs`：零依赖 JSON Schema 子集校验器
  - `examples/`：三份可直接抄的示例；`test/`：8 条（含反面用例）
- 插件侧 `src/formats/`：schema 与校验器的**副本**，`tools/sync-formats.mjs` 同步并**比对版本号**
- `skillStore.save()` 现在**先过格式校验**：不合格的技能写不进库
- README 增加"格式"一节，说明版本规则（1.x 只加字段不改语义）

### 过程中被抓出来的三处不一致（这正是把格式抽出来的价值）

校验一开，格式和真实数据立刻打架：

1. 编译产物里 `anchor` 可能是 null → schema 放宽为 `["object","null"]`
2. 参数上带 `step`/`tool` 来源 → schema 承认这两个字段
3. 存储层每次写都会更新 `updatedAt` → schema 加上它

另外修了校验器一个真 bug：`oneOf` 命中后**提前 return**，导致同层的
`required` / `additionalProperties` 全被跳过 —— 校验看起来通过，其实没查。

### 测试
267 → **272**（格式集成：编译产物必须能过格式校验、未知字段被拒、verify 形状校验）

## v0.15.0 — 2026-11-08

**M3 · 技能素材层。** 记得的是"下一步该干什么"，不是鼠标坐标。

### 新增

- **`src/memory/anchor.js`**：语义锚点
  - 从参数/输出里提取"操作的是什么"：显式文本（`text`/`url`/`selector`…）+ 容器窗口名
  - **拿不到语义线索时不假装拿到**：标 `fragile`，一路传到技能草案上
  - 只有"知道窗口名"不算可迁移——按坐标点的操作永远记 `fragile`
- **`src/memory/skills.js`**：从 episode 编译技能（纯函数）
  - `similarity()` / `clusterEpisodes()`：同类运行聚合（工具序列逐位 + 集合重合 + 意图）
  - `extractParams()`：同一位置多次取值不同 → 参数；**差异过大就放弃，不把特例当规则**
  - `compileSkill()`：每步产出 `{intent, tool, args, anchor, expect, onFail}`
  - **坐标绝不进模板**；没判据的步数如实记在 `incomplete` 里，不伪造 `expect`
- **`src/memory/skillStore.js`**：技能库 + 健康度
  - 健康度口径：连续 3 次失败 → `broken`；有失败且成功率 < 90% → `needs-review`；否则 `healthy`
  - 唯一入口 `recordRun()`，别处不许改健康度
- **anchor 落进 episode**：`toolServer` 每次调用都记 `anchor`（技能层的素材来源）
- **CLI**：`node bin/he-server.js skills [--min N] [--save]`

### 实测（真实历史）

```
$ node bin/he-server.js skills --min 1 --save
扫了 14 条 episode，同类出现 ≥1 次的技能草案：1 份

【系统状态巡检】skill_20261108_02
  来自 2 次运行 · 1 步 · 参数 0 个
  ⚠ 1 步没有判据（草案不完整，不能直接当"验过了"）
   s1 capability：system_deep

已存入技能库 1 份 -> %LOCALAPPDATA%\dsh-handeye-plus\skills
```

### 还没做（下一步）

- 面板里的技能页（列表 / 草案确认 / 健康度红条）
- 技能执行（**刻意不做自动重放**：v1 的价值是"交给模型照着做"）
- 画面上"检测到 3 次同类操作，存成技能？"的主动提示（现在要手动跑 CLI）
- `capability` 内部子步骤目前只记成 1 步，编译出来会偏粗（已知限制）

### 测试
248 → **267**（锚点 4 条 + 编译 9 条 + 技能库 8 条）

## v0.14.0 — 2026-11-08

**M2 · MCP 适配层。** 分水岭：从"插件"变成"层"——同一套工具、同一道门，Claude / ChatGPT / Cursor 都能接。

### 新增

- **`src/mcp/server.js`**：MCP over stdio
  - stdout 只写 JSON-RPC，日志走 stderr（否则客户端解析失败）
  - 消息**串行处理**：工具调用共享同一套运行时状态，乱序会互相踩
  - stdin 关闭时**等队列排空再退出**（实测 bug：短管道喂三条消息，最后一条调用被掐掉）
- **`src/mcp/protocol.js`**：纯函数协议层（输入一条消息 → 输出一条响应），可单测
  - `initialize` 回显客户端的 protocolVersion
  - `tools/list` 把内部的 `parameters` 映射成 MCP 的 `inputSchema`
  - `tools/call`：门卫拒绝与工具失败都标 `isError: true`
- **`src/server/headless.js`**：无宿主启动，CLI 与 MCP 共用一份启动逻辑
- `package.json` 增加 `bin` / `scripts.mcp`

### 实测（stdio 握手）

```
id=1 initialize  -> handeye@0.14.0 / proto=2025-06-18
id=2 tools/list  -> 47 工具
id=3 desk_windows-> isError=False / hwnd=132422 pid=17032 "StatusView" ...
id=4 不存在工具   -> isError=True / 失败：没有这个工具 nope_tool
```

### 测试
238 → **248**（协议 10 条：版本协商、inputSchema 映射、拒绝 → isError、抛错 → JSON-RPC 错误且服务不死、通知不回包、畸形消息、资源清单）

## v0.13.0 — 2026-11-08

**M1 · 抽层。** 核心从宿主里拆出来：调用、门卫、记账集中到一处，宿主只负责注册与转发。

### 新增

- **`src/server/toolServer.js`**：与宿主无关的工具服务器
  - `wrap(def)`：包一层——调用前过门卫，调用后记账（逻辑与历史版本逐字一致）
  - `callTool(name, args)`：**唯一入口**，门卫就在里面
  - `listTools()`：给 MCP / 文档用的工具清单（名称 + 说明 + 参数 schema）
  - 依赖全部注入（14 个端口），不 import 任何宿主 API；缺端口直接抛错，不会静默放行
- **`bin/he-server.js`**：独立命令行，证明核心能脱离 DSH 跑
  - `node bin/he-server.js list`
  - `node bin/he-server.js call desk_windows`
  - 用的是同一个 `callTool`，**命令行绕不过门卫**（同一份代码）
- `reg()` 缩成三行：只做注册，不再自带门卫

### 为什么这么做

门卫必须活在这个 `callTool` 里，不能活在任何一个适配器里。否则每接一个宿主就多一套门，
其中几套一定是漏的 —— 那就又回到了"假装在拦"。

### 实测

```
$ node bin/he-server.js call desk_windows     # 没有 DSH，直接读到 5 个真实窗口
hwnd=196888 pid=5496 "语音悬浮窗" class=BaseGui @(698,88 238x118)
hwnd=197872 pid=19012 "DeepSeek Harness" class=Chrome_WidgetWin_1 @(72,16 1296x828)
...
```

### 测试
229 → **238**（toolServer 9 条：拒绝短路、一次性授权、episode 记账、预算、meta 豁免、
失败标记、异常传播、清单、缺端口）

## v0.12.2 — 2026-11-08

**M0 · 止血。** 把审计里"门禁会说谎"的六条一次清干净。这一版不加任何新功能。

### 严重

1. **重启后判据丢失 → 步骤被静默标成完成**
   结账时 `goal_step_done` 只读内存里的 `state.verifyChecks`。进程重启后它是 null，
   `verifyStep` 直接返回 `{ok:true, checks:[]}` —— 一步没验就被标成 done。
   现在：结账前 `prepareStepChecks` 会按 `goalId + stepId` 从目标文件重新挂判据再验。
   回归测试：模拟重启（清空 state），必须验不过。

### 中等

2. **预算上限没夹死**：plan 里可以写 `actions: 1000000`，那道门就永远不会触发。
   现在门卫侧夹 1..40，写入 `normalizeSteps` 时也夹一次。
3. **被卡住的步骤能静悄悄重进**：`blocked` 变成无限重试。
   现在重进必须写 `reason`，并且 `verifyFailures` 清零（否则上一轮的失败会把这一轮直接判死）。
4. **`goal_step_continue` 加到"当前步骤"而不是文件里那一步**：两侧预算永久错位。
   现在只能续正在跑的那一步。
5. **目标类工具被当成"动作"**：`goal_step_continue` 自己会吃掉一个动作额度。
   现在 `goal_*` 不计入动作预算与路径打卡（它们是管理状态，不是动屏幕）。
6. **`/capabilities/save` 信任调用方传的 `risk`**：可以把含点击/输入的轨迹存成"只读"。
   现在只有 `destructive` 会被接受，其余由服务端重新分类。
7. **`readText` 读失败返回空串**：`text` 判据的 `absent` 会把"读不到"判成"没出现"=通过。
   现在读失败直接抛错，判据按失败处理。

### 测试
225 → **229**（重挂判据、blocked 重进、续预算目标、预算夹持）

## v0.12.1 — 2026-11-07

补 v0.12.0 里写了但没做的一条：**面板收起后定时器仍在跑**。

写 changelog 时把这条列成了"已修"，实际只改了注释没改逻辑 —— 当场发现，补上并留痕。

- 活动轮询：页面不可见（后台标签页）时直接跳过
- 状态轮询、页面数据轮询：面板收起时跳过（挂件上的计数本来就来自活动轮询，不受影响）

## v0.12.0 — 2026-11-07

### 破坏性动作现在真的需要用户点一次（新功能）

以前 `canAct` 对每个写操作都返回 `{ok:true, code:'CONFIRM_REQUIRED'}`，
而调用方只看 `ok` —— 所谓"二次确认"从来没发生过，全部直接放行。

- `canAct` 对 `destructive` 风险改为 `ok:false` + `CONFIRM_REQUIRED`
- 新增一次性授权：`POST /dsh-handeye-plus/confirm`（面板按钮触发）+ `GET /confirm/pending`
- 授权只存在内存里、只对**一个工具**、**两分钟**内有效，用完即焚，重启失效
- 面板「今天」页顶部出现红色确认条：「AI 想执行 hand_type（看起来是破坏性动作），要允许一次吗？」

⚠️ 边界说清楚：这道门约束的是**插件工具调用**。任何能在你机器上跑代码的东西
（包括模型自己的 shell 工具）都能直接改数据文件 —— 这是宿主权限问题，插件管不了。

### 验收判据不再读敏感目录（新策略）

`file` / `text` 判据的路径如果落在系统目录、`.ssh`/`.aws`/`.gnupg`、浏览器配置、
凭证目录，或后缀是 `.pem/.key/.pfx/.p12/.kdbx/.ovpn/.ppk`，直接判**失败**（不是跳过）。
以前可以用 `text` 判据把私钥读进来做子串判断 —— 等于一个 1 比特探针。

**为什么是黑名单不是白名单**（从用户和开源两个角度）：
- 用户角度：装上一个插件，开箱就该能用；白名单要求先配置根目录，配不明白就用不了，用户会直接关掉检查
- 开源角度：审查者会问"这玩意儿能不能把我的私钥读走"，一个默认拒绝敏感目录的实现是可以写进 README 的答案
- 它是减速带不是沙箱，文档里照实写，不吹成沙箱

### 修

- 面板「发送任务卡」没带 `cardId` → 卡片的验收判据在主流程里根本没挂上（UI 还标着"带验收"）
- `--he-border` 从未定义，浅色主题下卡片/表单边框是白底白线（看不见）
- `dispose` 漏移除入口按钮的捕获监听，热重载会叠加旧闭包
- 面板关闭后定时器仍在跑（1.5s 活动、2s 状态、4s 页面数据）

### 测试
224 → **225**

## v0.11.5 — 2026-11-07

专项审计第二轮：三个子代理分头扫 gate/verify/risk、goals 存储与状态、client+routes，
加上我自己查 index.js，一共确认 **16 个真问题**。这一版修掉其中 6 个，都是"门禁形同虚设"级别。

### 已修

1. **暂停可以被模型自己解除**（严重）
   `episode_begin` 是 meta 工具、不过门卫，而它内部 `beginEpisode` 会把状态改回 RUNNING、
   清掉 reason 和 allowedTools。于是"暂停"只是摆设：模型调一次 `episode_begin` 就能继续动手。
   现在暂停期间 `beginEpisode` 保持 PAUSED，只有用户恢复能动。

2. **判据配置写坏 → 验收门静默关闭**（严重）
   `normalizeChecks` 失败时，三处调用方都把它变成"没有判据"，于是验收照常推进（fail-open）。
   现在写坏判据会挂一个**必然验不过**的哨兵判据（用不存在的文件）。
   注意：我第一版哨兵写成了 `exit + echo`，退出码 0 反而通过 —— 那等于把门打开，已改。

3. **命令判据可注入**（严重）
   判据命令走 `cmd.exe /c`，白名单只看第一个 token，所以 `node -v & del /f x` 的 head 也是 node。
   现在含 `& | < > ^ % ! ; $ ?` 之类元字符一律拒绝（替换变量之后再检查一遍）。

4. **`'*'` 等于全部放行**（中等）
   `matchTool('*', t)` 恒真，而 `allowedTools` 是模型能自己传的参数 —— 白名单可以自己写、自己放大。
   现在单独一个星号不匹配任何工具，`browser_*` 也不会把 `browser` 本身带进来。

5. **`eye_shot` / `eye_region` 被当成只读**（中等）
   它们会按 `args.path` 往任意绝对路径写 PNG，暂停时却能直接跑、不计预算、不过白名单。现在算写操作。

6. **跨步冒领**（中等）
   在跑 s1 时可以调 `goal_step_done` 给 s3 结账，验的却是 s1 的判据。现在只能给正在跑的那一步结账。

### 测试
220 → **224**（暂停不可解除、星号不放行、截图算写、跨步结账被拒）

### 还没修（下一轮，按严重度）

- verify 从全局 state 取判据、不校验 stepId；重启后 state 丢失 → 判据空 → 步骤被静默标成完成
- 重复 `goal_step_enter` 同一步会把 `stepActions` 归零 → 预算可以无限刷新
- `budget.actions` 没有上限（可以写 1000000），而 `goal_step_continue` 却夹在 1..40
- `blocked` 的步骤可以立刻重进，`verifyFailures` 不复位 → blocked 循环
- `goal_step_continue` 加到"当前步骤"而不是文件里那一步；且它自己吃掉 1 个动作
- `normalizeSteps` 静默截断、id 会出现空洞（s1、s3）
- `CONFIRM_REQUIRED` 被调用方丢掉 → 破坏性动作永远没有二次确认
- 判据路径没有根目录约束（可以用 text 判据去探测任意文件）
- `capability run` 内部的每一步都不计入步骤预算
- `text` 判据在数据源读失败时，`absent` 会被判成"通过"

## v0.11.4 — 2026-11-07

专项找 bug，一次修五个。前三个都能让"门卫"形同虚设或把人锁死。

### 严重

1. **做完一个目标后，后续所有写操作被卡死**
   `goal_step_done` 完成最后一步后只清 `currentStep`，`goalId` 一直挂着 ——
   于是之后任何写操作都撞 `GOAL_STEP_REQUIRED`，模型会原地打转。
   现在全部步骤做完就自动放开焦点，并在回包提示 `goal_set_status done`。

2. **`episode_begin` 能冲掉步骤的验收判据**
   `episode_begin` 是 meta 工具、不过门卫，而它会重置 `verifyChecks` ——
   模型只要在完成前开一个新 episode，验收判据变空，整道验收门等于自己走掉。
   现在目标步骤进行中时，`episode_begin` 不许覆盖判据。

3. **写路由没有 CSRF 防护**
   路由挂在本机同源上、无鉴权，浏览器对 `text/plain` 的跨站 POST **不预检**，
   于是任意网页都能打 `/goals/override` 伪造"人工放行" ——
   而人工放行是唯一能绕过验收门的口子。
   现在 `readBody` 校验：Origin 必须同源（无 Origin 的本地脚本放行）、
   写请求必须是 `application/json`。实测：同源 200 / text-plain 415 / 跨站 403。

### 中等

4. **并发写同一个目标文件会崩，还会丢更新**
   所有写手共用 `<id>.json.tmp`，一个 rename 会抢走另一个正要用的临时文件 → ENOENT；
   同时 load→改→save 没有串行化 → 后写的覆盖先写的。
   现在：临时文件名唯一（pid+序号），并且按目标 id 串行化（不同目标互不阻塞）。
   实测 12 路并发：修前崩 + 丢，修后 12/12 全落盘。

5. **`episodes.prune()` 从来没被调用**
   episodes 的 jsonl 一个动作一行、无限增长。现在启动时清一次旧日子。

### 测试
220 个（+6：目标完成放开焦点 ×2、验收判据不被冲掉 ×1、并发写 ×2、路由 CSRF ×0 现场验证）

## v0.11.3 — 2026-11-07

度量再加一栏"路径拦截"，把两种拦截分开算。

实测数据暴露的问题：这次跑目标被拦了 2 次，都是 `PATH_DEVIATION`（路径没打卡），
但面板上"拦下越界"显示 **0** —— 因为该指标只统计 `GOAL_STEP_REQUIRED` /
`STEP_TOOL_NOT_ALLOWED`。数字不算错，但**看起来像没拦过**。

- `metrics.js` 新增 `pathRefused`（`PATH_DEVIATION`），与 `deviationRefused` 分开
- `formatMetrics` 多打一栏"路径拦截"
- 补测试

## v0.11.2 — 2026-11-07

修"最后一步的 episode 不落盘"。

实测跑完三步目标后查 `/episodes`：s1、s2 的 episode 都在（状态 superseded），
**s3 的找不到** —— 因为它只会在"下一步开始"时被 superseded 掉，而 s3 后面没有下一步了。

- `handleStepLeave` 结束步骤时显式 `flushActive()`：正常完成记 success，
  验收失败记 failure
- 之前 `handleStepLeave` 只做了 `endGoalStep()`，episode 就悬在那儿

## v0.11.1 — 2026-11-07

修"验收通过率虚高"：没有判据的步骤也被记成 `verify: pass`。

起因：用目标层跑了一次真实任务（订阅《太长不看》），三步都没有验收判据，
完成后 `runs` 里却是三条 `verify: pass` —— 于是度量显示"验收通过率"很好看，
实际上一条判据都没跑过。**度量说谎比没有度量更糟。**

- `goal_step_done` 只在真的跑过判据（`verdict.checks.length > 0`）时才记 `pass`，
  否则记 `none`；人工放行仍是 `override`
- 补回归测试：没判据的步骤完成后 `runs[0].verify === 'none'`
- 顺手修正了那次真实运行留下的记录（3 条 pass → none）

## v0.11.0 — 2026-11-07

把入口从顶部那一排挪到**输入框旁边的小圆按钮**（用户反馈：顶部那个太麻烦，点到要跑一趟）。

- 新增 `mountComposerEntry()`：从输入框往上找 10 层，找到带「发送/send」的按钮，
  在它左边插一个 28px 的圆按钮（眼睛图标，hover 变蓝）
- 三级回落：输入框旁边 → 顶部「对话/轨迹/上下文/编队」那一排 → 右下角挂件
- 点击用 document 捕获阶段委托，宿主重渲染换掉按钮也能打开
- 2 秒重挂一次，宿主重绘后按钮会自己回来
- 挂在输入框旁边时，顶部那一排多余的旧入口会被清掉

顺带修两个自己引入的 bug：
- `mountEntry` 的兜底写成了自调用（无限递归）
- 首次挂载仍然调的是 `mountTopTab`，导致输入框旁边的入口根本没出现

## v0.10.1 — 2026-11-07

修目标页的输入问题（用户实测反馈"输入有问题"）。

**根因**：目标页挂在 4 秒的自动刷新上，每次刷新都会 `pageGoals.replaceChildren()` 整页重画。
输入框是被整个替换掉的 DOM 节点 —— 于是**打到第 4 秒左右焦点被抢走、光标丢失**，
表现就是"打不进字 / 打了又没了"。
（旧的任务卡页早就为这个加过 `if (episodeCard.querySelector('input')) return` 的防重画判断，
新写的目标页漏了这条。）

- `renderGoals()` 增加输入守卫：只要焦点在目标页的 INPUT/TEXTAREA 里就跳过这次重画
- 定时刷新在打字期间也不再拉数据（拉完一样会触发渲染）
- 目标页的表单/放行框/步骤编辑框内部拦住 keydown/keypress/keyup，
  避免被宿主页面的全局快捷键吃掉按键

## v0.10.0 — 2026-11-07

**P2 界面 + P3 度量。** 设计稿（`docs\手眼插件-目标与提示词系统-设计.md`）的四个阶段全部落地。

### 新增
- 抽屉第五页「目标」：
  - 目标列表（`2/5 步 · 进行中 s2`），点开看步骤与验收判据
  - 新建目标（名字 + 长期目标原话）
  - 编辑步骤（一行一步，保存即 `setPlan`）
  - 每步：开始/继续、选提示词（列出任务卡，**带不带验收一眼可见**）、放行、跳过
  - 目标级：暂停 / 恢复
  - 设计约束：**执行动作一律通过"往对话框发一句话"交给模型**，只有放行与暂停是真的后端动作
- `src/core/metrics.js`（纯函数）+ `GET /dsh-handeye-plus/metrics`
  - 六个数字：目标、步骤、验收通过率、拦下越界、人工放行、卡住
  - 验收失败现在也写进 `runs`（verify=fail），通过率才有分母
  - 门卫拒绝按错误码计数（`GOAL_STEP_REQUIRED` / `STEP_TOOL_NOT_ALLOWED` / `STEP_BUDGET_EXCEEDED`）
- 目标页顶部显示这六个数字；没有验收记录时显示 `—` 而不是假的 0%

### 测试
- 206 → **213**：新增 `test/core/metrics.test.mjs`（7 条）
- 另做了路由冒烟：`/goals` 与 `/metrics` 真实调用通过

## v0.9.0 — 2026-11-07

**P1：目标层。** 长期目标 → 分项步骤 → 步骤门 + 步骤预算 + 失败升级。
设计见 `docs\手眼插件-目标与提示词系统-设计.md` §4、§6、§10。

### 新增
- `src/memory/goals.js`：目标存储（一目标一文件），步骤状态机
  `todo/doing/blocked/done/skipped`，**同时只允许一个 doing**（文件层面就校验）
- `src/tools/goals.js`：8 个工具
  - `goal_create` / `goal_plan` / `goal_status`
  - `goal_step_enter` / `goal_step_done` / `goal_step_continue` / `goal_skip_step` / `goal_set_status`
- 步骤门（`core/gate.js`）：
  - 目标在用、却没进步骤时，写操作一律拒（`GOAL_STEP_REQUIRED`）
  - 进步骤后，工具只能落在这一步的白名单里（`STEP_TOOL_NOT_ALLOWED`）
  - 每步动作预算（默认 8，软上限）超了拒（`STEP_BUDGET_EXCEEDED`），
    要用 `goal_step_continue` 续，且必须写原因（会写进记录）
- 失败升级：验收连挂两次 → 步骤 `blocked` + 动作锁死 + 明确要求人来决定

### 改变
- `goal_create` / `goal_plan` 会把目标设为"当前目标"，从这一刻起就必须按步骤走
- `goal_*` 与 meta 工具同等待遇：不会被"路径没打卡"这类规则误伤（它们本来就是管路径的）
- 首次验收失败**不会**离开步骤（步骤仍是 doing）；只有真 blocked 才解锁

### 测试
- 176 → **206**：新增 `test/memory/goals.test.mjs`（15）、
  `test/tools/goals.test.mjs`（9），gate 补 6 条步骤门用例

## v0.8.0 — 2026-11-07

**P0：验收门。** 把"我觉得做完了"换成"机器验过了"。设计见
`docs\手眼插件-目标与提示词系统-设计.md`（工作区仓库）。

### 新增
- 卡片可选字段：`category` / `inputs` / `estimatedSteps` / `verify`（全部可选，老卡片行为不变）
- `src/core/verify.js`：五种判据（`file` / `text` / `screen` / `exit` / `changed`）、
  `{{变量}}` 替换、逐条 expected-vs-actual 报告、命令白名单
- `episode_begin` 新增 `cardId` 与 `params`：挂上卡片验收、给判据里的变量赋值
- 人工放行：`%LOCALAPPDATA%\dsh-handeye-plus\override.json` 写 `{episodeId, reason}`，
  一次性消费；**故意不暴露成工具**，否则模型能自己绕过这道门

### 改变
- `episode_checkpoint` 改成**先验后推**：判据不过就不推进路径，回传每条的期望与实际；
  连续两次不过时额外提醒"别再自己换办法硬刚"
- `episode_begin` 会等卡片的验收/步骤挂完才返回（修掉一个异步竞态：
  原来紧接着的 checkpoint 可能看到空判据而静默跳过验收）
- 内置卡片 `write_doc` / `research_topic` 升到 v3：`path` 改为必填，
  带真实验收（文件存在 ≥200 字节；调研摘要还要含 `http` 出处）

### 测试
- 151 → **176**：新增 `test/core/verify.test.mjs`，schema 与 meta 各补 4~5 条

## v0.7.0 — 2026-11-07

一次真实任务（用浏览器订阅邮件通讯、点确认链接）暴露的三个硬伤，逐条修：

### 手：点击不再"盲点"
- 新增 `src/winui.ps1` + `src/winui.js`：聚焦、命中检测、按下鼠标在**同一个进程**里完成
- `hand_click` 新增 `hwnd` / `title` / `doubleClick` / `dryRun`：给目标窗口时，
  用 `WindowFromPoint` 确认这个像素确实属于它，**不属于就不点**，并说明实际压在上面的是谁
- 回包固定带上「命中窗口 / 目标窗口 / 操作后前台」，点错一眼能看出来
- `hand_focus` 改为「切完必须验证真的到前台」，Windows 拒绝时借前台线程输入队列重试，
  失败明确报错（原来是 handeye 回一句"已切换"就算成功）
- `hand_type` / `hand_key` 支持先切窗口；新工具 `hand_where` 只查询坐标属于哪个窗口
- `desk_tree` 对 Chromium 窗口补一句提示：读不到页面控件不是故障，是它不导出无障碍树

### 网页：能接管用户自己的浏览器
- 新增 `browser_attach`：扫描 `--remote-debugging-port`、`DevToolsActivePort` 与常见端口，
  接管**已登录**的 Chrome/Edge，保留 Cookie 与登录态
- 接管模式下 `browser_stop` 拒绝关闭用户的浏览器；端点消失就报错，绝不偷偷另起一个
- CDP 连接断开会立刻作废缓存并在下一次动作自动重连一次（原来只会一直说"调试通道已断开"）
- 独立实例的 stdout/stderr 落盘 `browser.log`，崩溃后能查原因

### 眼：等待与细读
- 新增 `eye_wait`：`appear` / `gone` / `change` 三种等待，全部带超时
- 新增 `eye_region`：GDI+ 直接抓屏裁一块放大（默认 3 倍）存 PNG，可选顺带 OCR；
  不依赖 handeye 存盘，沙箱里也能用
- `src/eye.js` 把这些逻辑收成可单测的纯函数

### 其他
- 工具从 35 个涨到 39 个；`hand_where` 保守归为只读，`browser_attach` 归为写操作
- 单测 127 → 151（新增 winui / eye / browser 三个测试文件）

## v0.6.6 — 2026-11-07

- 修复系统快照中文系统名称乱码：PowerShell 输出强制 UTF-8
- 127 个单测通过

## v0.6.5 — 2026-11-07

- 新增 `system_info` op 与两条只读能力：系统快照、系统深度巡检
- 「每日简报」「系统巡检」两张卡改为直通能力，点一下零决策出结果
- 直通运行会写入 episode（source=card-direct），今天页可统计成功率与直通次数
- 今天页「最近任务」标题显示：任务数 / 成功 / 成功率 / 直通
- 127 个单测通过

## v0.6.4 — 2026-11-07

- 检查点强制：任务卡路径每一步最多 3 个动作，超过后门卫拒绝，必须先调用 `episode_checkpoint` 记录完成
- 抽屉状态条显示「路径 2/4：当前步骤」
- 只读任务卡可声明 `directCapability`，「直接运行」按钮在服务端执行能力，模型不参与决策
- 新增 `/cards/run` 路由（只读能力；首次运行仍需授权）
- 126 个单测通过

## v0.6.3 — 2026-11-07

- 16 张内置任务卡全部加上「执行路径」：按顺序列出 3-5 步，提示词里明确「不要跳步」
- 发卡时按卡片自主等级自动生成工具白名单：只读卡物理上不能点击/输入，写卡才放行动作工具
- 卡片版本升到 2；内置卡升级时自动替换旧内置版本，不覆盖用户自己改过的卡
- 122 个单测通过

## v0.6.2 — 2026-11-07

- 任务卡发送时服务端直接开始 episode，省掉模型「先调用 episode_begin」的一轮决策
- 今天页每条任务显示「总时长 / 执行 / 决策」，决策层瓶颈可见
- 客户端、路由与测试保持 121 个单测通过

## v0.6.1 — 2026-11-07

- 面板入口移到会话顶部「对话 / 轨迹 / 手眼+ / 上下文 / 编队」这一排；注入失败时退回右上角挂件
- 新增 `capability save`：把一条成功 episode 编译成能力草稿（语义步骤保留，坐标点击/元素序号拒绝并给警告）
- 今天页新增「最近任务」，可内联填写名称、标题后存成能力草稿
- 新增 `/capabilities/save` 路由（写入 draft，不会自动启用）
- 121 个单测

## v0.6.0 — 2026-11-07

操作记忆、安全门卫与任务卡。

### 新增

- **episode 记录**：按天 JSONL、写入/读取双重脱敏、坏行跳过、按时间查询、保留期清理
- **能力层**：`capability` 工具（list / show / run），声明式步骤与后置断言；失败返回 trace、期望值和最后画面
- **能力仓库**：draft / enabled / disabled 生命周期、运行统计、预置安装、导入强制禁用
- **6 条预置能力**：读当前窗口、截图、等文字、开网址读正文、按文字点击并验证、查 DeepSeek 余额
- **16 张内置任务卡**：调研、看屏问答、整理文件夹、批量重命名、填表、写文档、仓库体检、系统巡检、截图汇报、页面对比、表格提取、安全审查、会议纪要、软件教学、每日简报等
- **状态机与门卫**：IDLE / RUNNING / PAUSED / REPLAN_REQUIRED；动作前统一过闸
- **暂停与重规划**：暂停只放读；恢复和约束型插话后必须先 `episode_replan`
- **风险分级与确认**：只读首次确认、写每次确认、不可逆不可记忆；一次性令牌 2 分钟过期
- **脱敏**：GitHub token、`sk-`、Bearer、`password=`、手机号、身份证在落盘前打码
- **四页面板**：今天 / 能力 / 任务卡 / 日志；系统日志页支持筛选、搜索、展开
- **只读/控制路由**：state、log、episodes、capabilities、cards、grant、control

### 变更

- `open_url` 默认走系统浏览器并自动切前台；`channel: "browser"` 才走独立 CDP 浏览器
- `read_text` 读到空内容时明确失败，不再假成功
- 预算只在 RUNNING 状态生效，避免未声明 episode 时误暂停
- 打开浏览器页面后等待正文出现再继续

### 测试

- 112 个 `node:test` 用例：状态机、门卫、schema、脱敏、episode、能力仓库、预置/任务卡、执行器、确认令牌、op 映射、日志缓存

## v0.5.0 — 2026-11-06

- 浏览器默认优先 Chrome
- `browser_stop` 同时识别 Chrome / Edge
- 文档整理与首次开源

## v0.4.0

- 活动面板重做为右侧抽屉（KPI、工具分布、失败卡、时间线）
- 浏览器启动不再带 NTP/同步页
- 新增 `browser_stop`
- 失败调用如实标记

## v0.3.0

- OCR 默认 2 倍放大
- 修复投影层：L0 不再谎报"可点 0 项"，L1 超预算只砍尾巴
- 增加投影单测

## v0.2.0

- 浏览器 CDP 通道，共 28 个工具

## v0.1.0

- 手 + 看 + 后台控件操作，20 个工具
