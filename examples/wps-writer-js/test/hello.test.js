/**
 * 加载项自己的测试模块（文字 · 纯 JS）。
 *
 * 两种跑法，跑的是同一份代码：
 *   终端：  npm run test:wps        （即 wps-bridge run ./test/hello.test.js --expect-report）
 *   页面：  Ribbon 上的「在加载项里跑测试」按钮 → /test/hello.test.js
 *
 * 页面里的这些函数来自 js/*.js（普通 <script>，所以是全局函数）；
 * 测试模块是 ES 模块，由 dev server 负责编译后发给页面。
 */
import { assert, assertEqual, runTests } from "./mini-test.js"

export default async function () {
  return runTests("WPS 文字 · 纯 JS Hello World", [
    ["buildHelloText() 返回问候语", () => {
      assertEqual(buildHelloText(), "Hello World")
    }],

    ["buildNotice(3) 带上写入次数", () => {
      assertEqual(buildNotice(3), "已写入「Hello World」（第 3 次）")
    }],

    ["点 btnHello：OnAction 把问候语写进文档", () => {
      window.Application.ActiveDocument.Content.Text = ""
      assertEqual(OnAction({ Id: "btnHello" }), true, "OnAction 应返回 true")
      assertEqual(readDocumentText(), "Hello World", "文档正文")
    }],

    ["未知控件 Id 不修改文档", () => {
      window.Application.ActiveDocument.Content.Text = "原有内容"
      OnAction({ Id: "btnNotExist" })
      assertEqual(readDocumentText(), "原有内容", "文档正文")
    }],

    ["Ribbon 回调是全局函数（WPS 才能找到）", () => {
      assert(typeof OnAction === "function", "OnAction 必须是全局函数")
      assert(typeof OnAddinLoad === "function", "OnAddinLoad 必须是全局函数")
    }],
  ])
}
