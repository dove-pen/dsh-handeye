// 失败标记：工具层唯一约定。
//
// 背景（2026-11-13）：失败判定原来是靠字符串前缀 `失败：`（toolServer.js:52）。
// 要把 199 条工具文案翻成英文，就不能"一步到位"改前缀 —— 漏翻一处，门卫就认不出失败。
// 所以先做**双读**：新旧两个标记都认。逐个文件翻完，最后再删旧的。

export const FAILURE_MARK = 'Failed: '

/** 过渡期兼容：全量英文化完成前，旧标记也认。 */
export const LEGACY_FAILURE_MARK = '失败：'

export const isFailure = (text) =>
  typeof text === 'string' && (text.includes(FAILURE_MARK) || text.includes(LEGACY_FAILURE_MARK))

/** 统一的失败文本：`Failed: <prefix>: <message>`。 */
export const failureText = (prefix, message) =>
  `${FAILURE_MARK}${prefix}: ${message instanceof Error ? message.message : String(message)}`
