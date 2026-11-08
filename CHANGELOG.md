# Changelog

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
