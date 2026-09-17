/**
 * 故意失败的测试模块。
 *
 * 由 test/examples.test.js 通过 `/@fs/` 路径在加载项页面里执行，
 * 用来验证桥的 `--expect-report`：报告行里有 failed 就返回退出码 1。
 *
 * （放在 fixtures 下面而不是某个示例里，是为了不污染示例 ——
 * 示例里的测试模块应该始终是绿的。）
 */

export default async function () {
  console.log("ok   1 + 1 === 2")
  console.log("FAIL 1 + 1 === 3  —— 期望 3，实际 2")
  console.log("故意失败的用例: tests=2 passed=1 failed=1")
  return { total: 2, passed: 1, failed: 1, text: "故意失败的用例: tests=2 passed=1 failed=1" }
}
