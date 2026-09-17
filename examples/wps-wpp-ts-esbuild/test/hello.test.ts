/**
 * 加载项自己的测试模块（演示 · TS + esbuild）。
 *
 * 两种跑法，跑的是同一份代码：
 *   终端：  npm run test:wps   （即 wps-bridge run ./test/hello.test.ts --expect-report）
 *   页面：  Ribbon 上的「在加载项里跑测试」按钮 → /test/hello.test.ts
 *
 * 注意这个文件是 .ts：桥的 `run` 支持 TypeScript，因为编译是 dev server 干的
 * （这里用 esbuild 按需打包），桥只管下发路径和收报告。
 */
import { assert, assertEqual, runTests } from "./mini-test"
import { buildHelloText, buildNotice } from "../src/hello"
import { insertHello, readTitle } from "../src/host"
import { OnAction } from "../src/ribbon"

export default async function () {
  return runTests("WPS 演示 · TS + esbuild Hello World", [
    ["buildHelloText() 返回问候语", () => {
      assertEqual(buildHelloText(), "Hello World")
    }],

    ["buildNotice(2) 带上次数与目标位置", () => {
      assertEqual(buildNotice(2), "已把「Hello World」写到第 1 页标题（第 2 次）")
    }],

    ["点 btnHello：OnAction 把问候语写到标题", () => {
      window.Application.ActivePresentation.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text = ""
      assertEqual(OnAction({ Id: "btnHello" }), true, "OnAction 应返回 true")
      assertEqual(readTitle(), "Hello World", "第 1 页标题")
    }],

    ["未知控件 Id 不修改标题", () => {
      window.Application.ActivePresentation.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text = "原有标题"
      OnAction({ Id: "btnNotExist" })
      assertEqual(readTitle(), "原有标题", "第 1 页标题")
    }],

    ["没有打开演示文稿时给出原因", () => {
      const app = window.Application
      const presentation = app.ActivePresentation
      app.ActivePresentation = undefined
      try {
        const result = insertHello(buildHelloText())
        assertEqual(result.ok, false, "应当写入失败")
        assert(result.reason.includes("演示文稿"), `原因应说明没有演示文稿，实际：${result.reason}`)
      }
      finally {
        app.ActivePresentation = presentation
      }
    }],
  ])
}
