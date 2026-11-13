// 工具层公用的小东西。刻意极小 —— 只放"每个工具都会用到"的两三个函数。

/** 把任意值当文本取，null/undefined 变空串。 */
export function text(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

// 统一失败前缀。判定在 core/markers.js（过渡期双读旧前缀），这里只负责输出英文。
export { FAILURE_MARK as FAILURE_PREFIX } from '../core/markers.js'

/** 工具失败文本：统一由 markers 生成，避免前缀散落在各处。 */
export const fail = (message) => `${'Failed: '}${message}`
