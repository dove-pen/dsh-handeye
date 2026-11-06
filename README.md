# dsh-handeye

一个 DSH 插件，把三样东西合成一个：**handeye 的手** + **杨镜的看** + **computer-use-win 的后台控件操作**。

设计原则一句话：**能用后台控件就不用鼠标，能按名字就不用坐标，能投影就不喂原文。**

---

## 它提供什么

### 看（感知，不花鼠标）

| 工具 | 用途 |
|---|---|
| `eye_see` | 看屏并投影。L0 一句话（这是什么界面、几个可点入口），L1 区块+控件+粗坐标，L2 全量 |
| `eye_find` | 按文字找位置（OCR） |
| `eye_changed` | 只问"屏幕变了没有"，走图像指纹，不做 OCR，最便宜 |
| `eye_shot` | 截图存成 PNG，**只返回路径**，图片不进对话 |
| `eye_text` | 文字瘦身：去重、去噪、保头保尾、报警行不丢 |

### 手（动作，会动鼠标）

| 工具 | 用途 |
|---|---|
| `hand_click` | 按坐标点击 |
| `hand_click_text` | 按文字点击（先 UIA 再 OCR），可带 `expect` 验证 |
| `hand_type` | 输入文字，支持中文，不占剪贴板 |
| `hand_key` | 按键 / 组合键 |
| `hand_focus` | 把窗口切到前台 |

### 后台控件操作（不碰鼠标，不抢前台）

| 工具 | 用途 |
|---|---|
| `desk_windows` | 列出所有窗口（hwnd / pid / 标题 / 类名 / 位置） |
| `desk_tree` | 读 UIA 控件树，每个节点带 `ref` |
| `desk_find` | 按名字/automationId 找控件，返回 ref |
| `desk_invoke` | 按控件（按钮、勾选、列表项、展开菜单），鼠标不动 |
| `desk_set_value` | 往输入框写值（ValuePattern），不按键、不占剪贴板 |
| `desk_focus` | 把键盘焦点移到控件 |
| `desk_text` | 直接读控件树里的文字，比 OCR 准 |
| `desk_launch` | 启动程序 / 打开文件或网址 |
| `desk_batch` | 一次进程内跑 1–20 个动作，出错即停 |

### 记账

| 工具 | 用途 |
|---|---|
| `yl_log` | 查 handeye 七段系统日志（谁点了什么、为什么失败） |

---

## 装

```powershell
# 在 DSH 终端里
dsh plugin --profile desktop add file:D:\Huawei\projects\dsh-handeye
```

或者在插件市场/插件页里选本地目录安装。

依赖：`D:\MouseRobot\handeye.exe`（可用环境变量 `HANDEYE_EXE` 改路径）。PowerShell 用系统自带的 5.1，不需要装别的东西。

**改完源码要重新安装一次**：DSH 的 profile 是复制而非软链，改文件不会自动生效。

```powershell
dsh plugin --profile desktop remove dsh-handeye
dsh plugin --profile desktop add file:D:\Huawei\projects\dsh-handeye
```

---

## 三级投影是怎么定的

来自 `docs\杨镜-设计文档.md`：

- **投影，不是摘要**：只删不编，同输入必然同输出，不调用模型。
- **报警通道永不降采样**：对话框、错误词、数字变化行、新窗口，任何级别都原样给。预算被报警行吃满时，预算让位。
- **L0 那句话是脸**：`[L0] 焦点「…」| 界面 32 块（content×32）| 可点 0 项 | 原始 79 行`

实测：同一屏 79 行 OCR → L0 一行。

---

## 什么时候用哪个

| 场景 | 用 |
|---|---|
| 标准 Windows 程序（计算器、设置、Office、资源管理器） | `desk_tree` → `desk_invoke` / `desk_set_value` |
| 自绘界面（微信、Chrome、Electron、Qt） | `hand_click_text` 或 `eye_see` + 坐标 |
| 只想确认"有没有变" | `eye_changed` |
| 要看图（图表、画布、复杂对话框） | `eye_shot` 拿路径，交给能看图的模型 |
| 长日志/长文档要进上下文 | `eye_text` 先瘦身 |

---

## 已知边界

- **UIA 取决于程序有没有实现**。Win32/XAML/UWP 一般没问题；Chrome 默认只给一层 Pane，要读网页得走 CDP（还没做）；WinForms 的 EDIT 在这台机器上只暴露成 Pane，`desk_set_value` 会失败，得退回 `desk_focus` + `hand_type`。
- **后台点击不是万能的**。有些控件只有 InvokePattern 能用、有些只认鼠标，`desk_invoke` 会明确告诉你"这个控件没有可用的模式"。
- **会抢键鼠**。`hand_*` 和 `desk_*` 不要和别的自动化工具同时跑。

---

## 路线

- v0.1（当前）：上面全部工具，已实测
- v0.2：浏览器 CDP 通道（`browser_open` / `browser_click` / `browser_fill`），把 Chrome 的网页操作补齐
- v0.3：`zoom` 下钻（按 ref 取 L2 而不重新截屏）、词化指令代理

---

## 署理

代码 MIT。投影层的设计来自 `docs\杨镜-设计文档.md`，动作层是 `D:\MouseRobot\handeye.exe`，后台控件操作的思路借鉴了 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)。
