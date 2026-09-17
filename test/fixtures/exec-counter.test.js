/**
 * 记录“这个模块被求值了几次”。
 *
 * 用来验证 `--fresh`：默认 run 拿到的是页面里**同一个模块实例**（不会重复执行），
 * 加了 --fresh 才会让 dev server 重新编译、页面重新求值。
 */

const scope = /** @type {any} */ (globalThis)
scope.__wpsBridgeExecutions = (scope.__wpsBridgeExecutions ?? 0) + 1

export default async function () {
  return { executions: scope.__wpsBridgeExecutions }
}
