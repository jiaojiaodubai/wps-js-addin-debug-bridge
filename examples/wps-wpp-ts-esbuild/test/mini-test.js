/**
 * 极简测试框架（零依赖、浏览器安全），只为一件事服务：
 * 把断言结果汇总成一行桥能识别的报告 ——
 *
 *     <标题>: tests=3 passed=3 failed=0
 *
 * 桥的 `--expect-report` 默认就找这一行（可用 `--report-pattern` 换成别的格式），
 * 并按其中的 `failed=` 决定退出码。想换成 vitest / jest / node:test 也行，
 * 只要最终往 console 打出同样一行报告即可。
 *
 * 三个示例里的这份文件是同一份（示例之间刻意不互相依赖，方便单独拷走）。
 */

/** 断言为真。 */
export function assert(condition, message = "断言失败") {
  if (!condition) throw new Error(message)
}

/** 断言严格相等。 */
export function assertEqual(actual, expected, message = "值不相等") {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}：期望 ${format(expected)}，实际 ${format(actual)}`)
  }
}

/** 断言文本匹配正则。 */
export function assertMatch(text, pattern, message = "文本不匹配") {
  if (!pattern.test(String(text))) {
    throw new Error(`${message}：${format(text)} 不匹配 ${pattern}`)
  }
}

function format(value) {
  if (typeof value === "string") return JSON.stringify(value)
  try {
    return JSON.stringify(value) ?? String(value)
  }
  catch {
    return String(value)
  }
}

/**
 * 依次跑用例并汇总。
 *
 * @param {string} title 报告里显示的标题
 * @param {Array<[string, () => unknown]>} cases 用例名与用例函数（可返回 Promise）
 * @returns {Promise<{ title: string, total: number, passed: number, failed: number, text: string }>}
 */
export async function runTests(title, cases) {
  const results = []
  for (const [name, fn] of cases) {
    try {
      await fn()
      results.push({ name, ok: true })
    }
    catch (error) {
      results.push({ name, ok: false, detail: error?.message ?? String(error) })
    }
  }

  // 每条用例一行，方便终端里看清是哪一个挂了（桥会把这些日志原样打出来）
  for (const result of results) {
    console.log(result.ok ? `ok   ${result.name}` : `FAIL ${result.name}  —— ${result.detail}`)
  }

  const failed = results.filter(result => !result.ok).length
  const text = `${title}: tests=${results.length} passed=${results.length - failed} failed=${failed}`
  console.log(text)
  return { title, total: results.length, passed: results.length - failed, failed, text }
}
