# dsh-handeye（手眼+）

DeepSeek Harness（dsh）插件：**手（真实鼠标键盘）+ 眼（屏幕投影）+ 后台控件操作（UIA）+ 浏览器 CDP**，再加一层**操作记忆与安全护栏**。

> A computer-use plugin for DeepSeek Harness on Windows that remembers how tasks were done, with hard pause/re-plan gates and a full audit trail.

设计原则一句话：**能用后台控件就不用鼠标，能按名字就不用坐标，能投影就不喂原文；记住的流程第二次不再问模型。**

---

## v0.6 新增：会记住、能被拦住

| 新增 | 说明 |
|---|---|
| **episode 记录** | 每次任务的动作、参数、耗时、结果写成本地 JSONL；写入前脱敏，读取时再脱敏一次 |
| **能力（capability）** | 把一条成功流程固化成声明式步骤（`open_url` / `wait_text` / `click_text` / `read_text` / `screenshot` …），第二次一条命令跑完 |
| **任务卡（16 张内置提示词）** | 调研、看屏问答、整理文件夹、批量重命名、填表、写文档、仓库体检、系统巡检、截图汇报、页面对比、表格提取、安全审查、会议纪要、教学、每日简报等；也可自己新增 |
| **四页抽屉** | 今天 / 能力 / 任务卡 / 日志 |
| **系统日志页** | 直接读 handeye 七段日志：KPI、级别/来源、搜索、点击展开详情 |
| **状态机与门卫** | `IDLE → RUNNING → PAUSED / REPLAN_REQUIRED`；暂停只放读，恢复必须复述计划 |
| **风险分级** | 只读首次确认、写操作每次确认、不可逆永远确认且不可记住 |
| **确认令牌** | 一次性、2 分钟过期、绑定动作风险 |
| **脱敏** | GitHub token、`sk-`、Bearer、`password=`、手机号、身份证在落盘前打码 |

预置 6 条能力：读当前窗口、截图、等文字、开网址读正文、按文字点击并验证、查 DeepSeek 余额。
预置只读能力首次运行仍需一次授权；写能力默认禁用。

---

## 它提供什么

### 看（感知，不花鼠标）

| 工具 | 用途 |
|---|---|
| `eye_see` | 看屏并投影：L0 一句话 / L1 区块+控件+粗坐标 / L2 全量；OCR 默认 2 倍放大 |
| `eye_find` | 按文字找位置 |
| `eye_changed` | 只问"屏幕变了没有"，图像指纹，最便宜 |
| `eye_shot` | 截图存 PNG，只返回路径 |
| `eye_wait` | 等事情发生：文字出现 / 文字消失 / 画面变化，带超时，不用 sleep |
| `eye_region` | 按框裁一小块并放大（默认 3 倍）存 PNG，可选顺带 OCR；读验证码、金额、时间戳用这个 |
| `eye_text` | 文字瘦身：去重、去噪、保头保尾、报警行不丢 |

### 手（动作，会动鼠标）

`hand_click`、`hand_click_text`、`hand_type`、`hand_key`、`hand_focus`、`hand_where`。

`hand_click` 支持 `hwnd` / `title`：一次调用内先聚焦、再问 Windows「这个像素属于谁」，
不属于目标就把点击**拦下来**并说明原因，而不是点错窗口还报成功。
`dryRun: true` 只做聚焦和命中判断、不按下鼠标。
`hand_where` 只问「这个坐标现在属于哪个窗口」，不点。

### 后台控件（不碰鼠标）

`desk_windows`、`desk_tree`、`desk_find`、`desk_invoke`、`desk_set_value`、`desk_focus`、`desk_text`、`desk_launch`、`desk_batch`。

### 网页（按元素，不猜坐标）

`browser_open`、`browser_attach`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_text`、`browser_navigate`、`browser_tabs`、`browser_close`、`browser_stop`。

`browser_attach` 接管**用户正在用的**浏览器（需它带 `--remote-debugging-port` 启动）：
有登录态和 Cookie，可以点确认邮件里的链接；这个模式下 `browser_stop` 不会关掉用户的浏览器。

### 记忆与审计

| 工具 | 用途 |
|---|---|
| `episode_begin` / `episode_query` | 声明任务、回看历史 |
| `capability` | `list` / `show` / `run`；执行前过门卫与确认 |
| `episode_replan` | 暂停或收到约束后，先复述计划才放行动作 |
| `pause_request` | 模型自己喊停 |
| `yl_log` | 查 handeye 七段系统日志 |

共 **39 个工具**（33 个手眼 + 4 个 meta + 1 个能力）。

---

## 验收门（v0.8）：把"我觉得做完了"换成"机器验过了"

以前 `episode_checkpoint` 是模型自己喊一声就推进，路径清单形同虚设。
现在只要这一轮任务挂了验收判据，**判据不过路径就不动**，并把每条的期望值和实际值一起吐回来：

```
失败：这一步的验收没过，路径没有推进。
验收没过（0/1 通过）
  [失败] 文件 D:\out\摘要.md：期望 存在且 ≥ 200 字节；实际 文件不存在
```

### 给卡片写判据

任意卡片加一个 `verify` 数组（可选，不写就是老行为）：

```json
{
  "id": "research_topic",
  "params": { "topic": {"type":"string","required":true}, "path": {"type":"string","required":true} },
  "inputs": ["topic", "path"],
  "verify": [
    { "type": "file", "path": "{{path}}", "minBytes": 200 },
    { "type": "text", "file": "{{path}}", "appear": "http" }
  ]
}
```

五种判据，只做机器能查的，不做"写得好不好"：

| type | 通过条件 |
|---|---|
| `file` | 文件存在且字节数 ≥ `minBytes` |
| `text` | 文件或屏幕上**包含** `appear` / **不包含** `absent` |
| `screen` | 屏幕上出现某段文字 |
| `exit` | 命令退出码为 0（命令有白名单：node/npm/npx/git/dir/type/echo/findstr） |
| `changed` | 画面与上一次观察相比有变化 |

`{{path}}` 这类变量来自 `episode_begin` 的 `params`；变量没值直接判失败，不会拿空字符串蒙混过关。

### 人工放行

判据太严时，**用户**可以放行一次：

```json
// %LOCALAPPDATA%\dsh-handeye-plus\override.json
{ "episodeId": "ep_20261107_213144_7bca22", "reason": "我看过了，可以" }
```

下一次 `episode_checkpoint` 消费掉这个文件就失效，下一轮任务不会白过。
**故意不提供工具入口**：模型能自己放行的话，这道门就等于没有。

---

## 面板

入口在会话顶部那一排：**对话 / 轨迹 / 手眼+ / 上下文 / 编队**。点「手眼+」打开右侧抽屉；宿主没有可注入的位置时，退回右上角的小挂件。

右侧抽屉四页：

- **今天**：KPI、工具分布环、失败卡、可筛选时间线
- **能力**：状态 / 风险 / 来源 / 运行统计，可启用、禁用、授权一次
- **任务卡**：选一张直接发进对话框，附目标、约束、成功标准
- **日志**：事件数 / 错误 / 警告 / 来源，级别筛选、搜索、点击展开详情

底栏常驻版本、handeye 路径和**暂停**按钮；暂停后红条提示，恢复需要 AI 先复述计划。

路由（同源、只读为主）：`/dsh-handeye-plus/state`、`/log/tail`、`/episodes`、`/capabilities`、`/cards`；写操作只有 `grant`、`capabilities/set`、`cards/set`、`control`。

---

## 安全模型

1. **动作前唯一闸门**：暂停时只放行读；`REPLAN_REQUIRED` 时拒绝一切动作，直到 `episode_replan`。
2. **工具白名单**：任务卡可以声明允许的工具，越界直接拒绝。
3. **风险分级**：`read` / `write` / `destructive`；只读首次确认，写每次确认，不可逆每次确认且不记忆。
4. **确认来自人**：面板的「授权本次」或一次性令牌；模型自己不能给自己授权。
5. **导入的任务卡**强制 `supervised`，且必须展示全文后确认。
6. **脱敏在写入口**：episode 与日志视图里看不到完整 token、手机号、身份证。
7. **审计**：每个动作都有 episode 记录，失败带 trace、期望值与最后画面。

已知边界：插件层的暂停拦不住模型绕过插件直接调 `handeye.exe`；后续版本会让 handeye 自己读取暂停标志。

---

## 装

```powershell
# 在 DSH 终端里，把 <本仓库路径> 换成实际目录
dsh plugin --profile desktop add file:<本仓库路径>
```

依赖：**自带 `bin/handeye.exe`**。查找顺序：`HANDEYE_EXE` → 插件目录 `bin\handeye.exe`。

平台：**Windows**。PowerShell 用系统自带 5.1。

**改完源码要重新安装一次**（profile 是复制而非软链）：

```powershell
dsh plugin --profile desktop remove dsh-handeye
dsh plugin --profile desktop add file:<本仓库路径>
```

---

## 能力格式

能力是声明式 JSON，核心字段：

```json
{
  "schemaVersion": 1,
  "name": "check_deepseek_balance",
  "title": "查 DeepSeek 余额",
  "risk": "read",
  "status": "enabled",
  "params": {},
  "preconditions": [],
  "steps": [
    { "op": "open_url", "url": "https://platform.deepseek.com/usage" },
    { "op": "wait_text", "text": "充值余额", "timeoutMs": 25000 },
    { "op": "read_text", "pattern": "¥([0-9.]+)", "as": "balance" }
  ],
  "postconditions": [{ "assert": "isset", "var": "balance" }],
  "outputs": ["balance"]
}
```

支持的 op：`open_url`、`focus_window`、`wait_text`、`click_text`、`type_text`、`press_key`、`read_text`、`assert_text`、`screenshot`、`scroll_to_text`（暂未实现）。

`open_url` 默认用系统浏览器（保留登录态）并自动切前台；`channel: "browser"` 走独立配置的 CDP 浏览器（无登录态，但文字更准）。

能力全部来自 `presets/` 与用户从 episode 固化，**不预置删除、提交、付款类动作**。

---

## 三级投影

- 投影，不摘要：同输入同输出，不调用模型
- 报警通道永不降采样
- 实测同一屏 79 行 OCR → L0 一行

---

## 已知边界

- **UIA 取决于程序实现**；读不到时退回 `desk_focus` + `hand_type` 或 `eye_see`
- **后台点击不是万能**：没有可用模式的控件会明确报错
- **浏览器 CDP 通道不带登录态**，需要登录的站点要在那个窗口登一次
- **会抢键鼠**：`hand_*` / `desk_*` 不要和别的自动化同时跑
- **能力会随 App 改版腐化**：失败会返回现场，需要人重新固化

---

## 路线

- v0.1–0.5：手眼工具集、投影层、面板、浏览器通道、开源
- **v0.6（当前）**：episode、能力、任务卡、系统日志页、门卫/暂停/重规划、脱敏、112 个单测
- v0.7：从重复 episode 自动建议固化能力、插话走 RPC（`session/prompt` steer）、handeye 读取暂停标志、包名迁移 `dsh-handeye-plus`
- v1.0：跨应用稳定性与公开基准

---

## 测试

```powershell
npm test
# 没有 node 时用 DSH 自带 node：
$env:ELECTRON_RUN_AS_NODE=1; & '<DSH 安装目录>\DeepSeek Harness.exe' --test
```

覆盖：状态机、门卫、schema、脱敏、episode 存储、能力仓库、预置/任务卡校验、执行器、确认令牌、op 映射、日志读取与缓存。真机测试单独做，不进 CI。

---

## 许可与致谢

MIT。动作层 `handeye` 来自 [Alan-dot-C/MouseRobot](https://github.com/Alan-dot-C/MouseRobot)；
后台控件思路借鉴 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)；
面板视觉参考 [dsh-context](https://github.com/bowenliang123/dsh-context)。
