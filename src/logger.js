/**
 * 桥自己的诊断输出。
 *
 * 为什么要单独一层：**stdout 留给被测页面**（CI 靠它抓报告行，用户靠它看测试输出），
 * 桥自己的碎碎念一律走 stderr。混在一起的后果很具体：
 * `wps-bridge run ./test/perf.ts > 报告.txt` 会把桥的日志一起写进去。
 */

import process from "node:process"

/**
 * @param {object} [options]
 * @param {boolean} [options.quiet] 只输出错误
 * @param {NodeJS.WritableStream} [options.stream] 默认 stderr
 */
export function createLogger({ quiet = false, stream = process.stderr } = {}) {
  const write = (text) => {
    if (quiet || !text) return
    stream.write(`[wps-bridge] ${text}\n`)
  }

  return {
    info: write,
    warn: text => write(`警告：${text}`),
    /** 错误不受 --quiet 影响：出问题时必须看得见。 */
    error: text => stream.write(`[wps-bridge] ${text}\n`),
    /** 原样输出（例如要自己带前缀的场景）。 */
    raw: text => stream.write(text),
  }
}
