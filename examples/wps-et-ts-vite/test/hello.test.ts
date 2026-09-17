/**
 * 加载项自己的测试模块（表格 · TS + Vite）。
 *
 * 两种跑法，跑的是同一份代码：
 *   终端：  npm run test:wps   （即 wps-bridge run ./test/hello.test.ts --expect-report）
 *   页面：  Ribbon 上的「在加载项里跑测试」按钮 → /test/hello.test.ts
 *
 * 注意这个文件是 .ts：桥的 `run` 支持 TypeScript，因为编译是 dev server 干的
 * （vite 用 esbuild 转译），桥只管下发和收报告。
 */
import { assert, assertEqual, runTests } from "./mini-test"
import { buildHelloText, buildNotice } from "../src/hello"
import { insertHello, readCell } from "../src/host"
import { OnAction } from "../src/ribbon"

export default async function () {
  return runTests("WPS 表格 · TS + Vite Hello World", [
    ["buildHelloText() 返回问候语", () => {
      assertEqual(buildHelloText(), "Hello World")
    }],

    ["buildNotice(2) 带上次数与目标单元格", () => {
      assertEqual(buildNotice(2), "已写入「Hello World」到 A1（第 2 次）")
    }],

    ["点 btnHello：OnAction 把问候语写进 A1", () => {
      window.Application.ActiveWorkbook.ActiveSheet.Range("A1").Value2 = ""
      assertEqual(OnAction({ Id: "btnHello" }), true, "OnAction 应返回 true")
      assertEqual(readCell(), "Hello World", "A1 的值")
    }],

    ["未知控件 Id 不修改单元格", () => {
      window.Application.ActiveWorkbook.ActiveSheet.Range("A1").Value2 = "原有内容"
      OnAction({ Id: "btnNotExist" })
      assertEqual(readCell(), "原有内容", "A1 的值")
    }],

    ["没有打开的工作簿时给出原因", () => {
      const app = window.Application
      const workbook = app.ActiveWorkbook
      app.ActiveWorkbook = undefined
      try {
        const result = insertHello(buildHelloText())
        assertEqual(result.ok, false, "应当写入失败")
        assert(result.reason.includes("工作簿"), `原因应说明没有工作簿，实际：${result.reason}`)
      }
      finally {
        app.ActiveWorkbook = workbook
      }
    }],
  ])
}
