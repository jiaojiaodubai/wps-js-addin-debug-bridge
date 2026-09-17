/**
 * 页面工具。
 *
 * notify 是**加载项侧的桥约定**（见桥的 README）：有桥时把提示变成一条日志回传终端，
 * 没有桥时退回 alert。为什么不直接用 alert：宿主里的模态弹窗会冻结加载项页面的
 * 脚本线程，弹窗一出现，桥的命令就再也送不进来了。
 */
export function notify(text: string): void {
  const bridge = window.__wpsDebugBridge
  if (bridge && typeof bridge.notify === "function") {
    bridge.notify(text)
    return
  }
  alert(text)
}

/** 加载项根路径，拼 ui/ 等资源地址时用（例如弹对话框、任务窗格）。 */
export function getUrlPath(): string {
  const url = decodeURI(document.location.toString())
  const index = url.lastIndexOf("/")
  return index === -1 ? url : url.substring(0, index)
}
