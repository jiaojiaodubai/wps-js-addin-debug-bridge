/**
 * Ribbon 回调。
 *
 * 这些函数由 src/main.ts 挂到 window 上（WPS 按 ribbon.xml 里写的名字找全局函数）。
 * 桥的 `click btnHello` 调用的就是这里同一个 OnAction —— 等价于“替用户点一下按钮”。
 */

import { buildHelloText, buildNotice } from "./hello"
import { insertHello } from "./host"
import { notify } from "./util"

export interface RibbonControl {
  Id: string
}

export function OnAddinLoad(ribbonUI: unknown): boolean {
  // 存下来，之后用它刷新按钮状态（Application.ribbonUI.InvalidateControl）
  window.Application.ribbonUI = ribbonUI
  window.Application.PluginStorage.setItem("helloCount", 0)
  return true
}

export function OnGetEnabled(): boolean {
  return true
}

export function OnAction(control: RibbonControl): boolean | Promise<string> {
  switch (control.Id) {
    case "btnHello":
      return insertHelloAndNotify()
    case "btnRunTests":
      return runAddinTests()
    default:
      return true
  }
}

/** 按钮：把 Hello World 写进 A1。 */
function insertHelloAndNotify(): boolean {
  const app = window.Application
  const count = Number(app.PluginStorage.getItem("helloCount") ?? 0) + 1
  app.PluginStorage.setItem("helloCount", count)

  const result = insertHello(buildHelloText())
  notify(result.ok ? buildNotice(count) : `写入失败：${result.reason}`)
  return result.ok
}

/**
 * 按钮：在加载项页面里跑测试。
 *
 * 走页面自己的模块系统，因此与终端里的 `wps-bridge run ./test/hello.test.ts`
 * 跑的是同一个文件、同一份代码。
 * 路径写成变量是为了同时绕开打包器与 TS 的静态分析：这是要靠 dev server 在运行期解析的地址。
 */
export async function runAddinTests(): Promise<string> {
  const testModulePath = "/test/hello.test.ts"
  const module = await import(/* @vite-ignore */ testModulePath) as {
    default: () => Promise<{ text: string }>
  }
  const summary = await module.default()
  notify(summary.text)
  return summary.text
}
