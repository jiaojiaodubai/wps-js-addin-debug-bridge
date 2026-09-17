/**
 * Ribbon 回调。
 *
 * WPS 按 ribbon.xml 里写的名字（onLoad="OnAddinLoad"、onAction="OnAction"）来找全局函数，
 * 而 index.html 用普通 <script> 加载本文件，所以顶层 function 正好就是全局函数。
 * 也正因为如此，桥的 `click <控件Id>` 能等价于“替用户点一下按钮”：
 * 它调用的就是这里同一个 OnAction。
 */

function OnAddinLoad(ribbonUI) {
  // 存下来，之后用它刷新按钮状态（Application.ribbonUI.InvalidateControl）
  window.Application.ribbonUI = ribbonUI
  window.Application.PluginStorage.setItem("helloCount", 0)
  return true
}

function OnAction(control) {
  switch (control.Id) {
    case "btnHello":
      return insertHello()
    case "btnRunTests":
      return runAddinTests()
    default:
      return true
  }
}

/** 按钮：把 Hello World 写进当前文档。 */
function insertHello() {
  const count = Number(window.Application.PluginStorage.getItem("helloCount") ?? 0) + 1
  window.Application.PluginStorage.setItem("helloCount", count)

  const result = insertHelloWorld(buildHelloText())
  notify(result.ok ? buildNotice(count) : `写入失败：${result.reason}`)
  return result.ok
}

/**
 * 按钮：在加载项页面里跑测试。
 *
 * 走的是页面自己的模块系统（dev server 负责编译），因此和终端里的
 * `wps-bridge run ./test/hello.test.js` 跑的是同一个文件、同一份代码。
 */
function runAddinTests() {
  return import("/test/hello.test.js")
    .then(module => module.default())
    .then(summary => notify(summary.text))
    .catch(error => notify(`测试执行失败：${error && error.message ? error.message : error}`))
}
