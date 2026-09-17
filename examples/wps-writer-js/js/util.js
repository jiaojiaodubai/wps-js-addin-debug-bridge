/**
 * 通用小工具（与官方模板同名同义，改自 wpsjs 的加载项模板）。
 *
 * 这些文件都是普通 <script>（不是模块），顶层 function 会直接挂到全局，
 * 所以既可以被 ribbon.xml 的回调找到，也能被测试模块直接调用。
 */

/** 加载项根路径，拼 ui/ 等资源地址时用（例如弹对话框、任务窗格）。 */
function GetUrlPath() {
  const url = decodeURI(document.location.toString())
  const index = url.lastIndexOf("/")
  return index === -1 ? url : url.substring(0, index)
}

/**
 * 页面提示。
 *
 * 桥在页面里挂了 window.__wpsDebugBridge：有桥时把提示变成一条日志回传给终端，
 * 没有桥时退回 alert。规格见 README「加载项侧约定」——
 * alert 会冻结加载项页面的脚本线程，之后桥的命令就再也送不进来了。
 */
function notify(text) {
  const bridge = window.__wpsDebugBridge
  if (bridge && typeof bridge.notify === "function") {
    bridge.notify(text)
    return
  }
  alert(text)
}
