// 工具层公用的小东西。刻意极小 —— 只放"每个工具都会用到"的两三个函数。

/** 把任意值当文本取，null/undefined 变空串。 */
export function text(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/** 统一失败前缀：工具层靠它标记失败（"失败：" 会被 isFailure 识别）。 */
export const fail = (message) => `失败：${message}`

/** 输出里带这个前缀就算失败。 */
export const FAILURE_PREFIX = '失败：'
