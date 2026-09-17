/**
 * 桥的共享协议：插件（服务端）、客户端（页面侧）与运行器（终端侧）都引用这里的常量。
 *
 * 该模块必须保持“浏览器安全”：客户端会直接 import 它，不能出现 Node 专有 API。
 */

/** 桥的 URL 前缀，所有接口与静态资源都挂在它下面。 */
export const BRIDGE_PREFIX = "/__wps_debug_bridge"

/** 注入到页面的客户端脚本地址。 */
export const CLIENT_SCRIPT_PATH = `${BRIDGE_PREFIX}/assets/client.js`

/** 客户端与服务端共享的协议模块地址（客户端按相对路径 import）。 */
export const PROTOCOL_MODULE_PATH = `${BRIDGE_PREFIX}/assets/protocol.js`

/** 桥的 HTTP 接口前缀。 */
export const API_PREFIX = `${BRIDGE_PREFIX}/api`

/**
 * dev server 把自己的端口/token 落在这里，终端侧据此自动找到桥。
 * 相对项目目录：两个进程的工作目录一般都是加载项项目根。
 */
export const DEFAULT_PORT_FILE = ".wps-bridge.json"

/** 页面侧约定：加载项把非阻塞提示（例如测试汇总）交给该全局对象。 */
export const HOOK_GLOBAL = "__wpsDebugBridge"

/** 长轮询时长。 */
export const POLL_TIMEOUT_MS = 25_000

/** 客户端空闲多久后视为断开。 */
export const CLIENT_TTL_MS = 45_000

/** `--expect-report` 默认匹配的报告行（可按项目改成任意正则）。 */
export const DEFAULT_REPORT_PATTERN = "tests=(\\d+) passed=(\\d+) failed=(\\d+)"

/**
 * 页面侧与终端侧之间的协议版本。
 *
 * 页面由 dev server 下发，正常情况下两边永远同版本；不一致只会出现在
 * “dev server 重启过、但加载项页面还是旧的”这种场景。这时明确报错
 * （并提示重新加载加载项）比让命令莫名其妙地失败要好得多。
 *
 * v3：信标（beacon）取代 busy 心跳，并携带主线程的 mainTickAt；
 *     客户端状态从 idle/busy/blocked 改为 idle/busy/stalled/offline。
 */
export const PROTOCOL_VERSION = 3

/** 客户端脚本地址带上版本，避免浏览器/宿主缓存旧客户端。 */
export const CLIENT_SCRIPT_URL = `${CLIENT_SCRIPT_PATH}?v=${PROTOCOL_VERSION}`

/**
 * 把页面里的 console 文本按报告正则解析。
 * @param {string} text 页面日志文本（可能是多行）
 * @param {string} pattern 正则源码，需含 `failed=(\d+)` 分组
 * @returns {{ total: number|null, passed: number|null, failed: number, line: string }|null}
 */
export function matchReport(text, pattern = DEFAULT_REPORT_PATTERN) {
  const regex = new RegExp(pattern)
  for (const line of String(text).split(/\r?\n/)) {
    const matched = regex.exec(line)
    if (!matched) continue
    const numbers = matched.slice(1).map(value => Number(value))
    const failed = numbers.length > 0 ? numbers[numbers.length - 1] : 0
    return {
      total: numbers[0] ?? null,
      passed: numbers.length > 1 ? numbers[1] : null,
      failed: Number.isFinite(failed) ? failed : 0,
      line,
    }
  }
  return null
}

/**
 * 描述一条命令，用于日志。
 * @param {{ kind?: string, controlId?: string, module?: string, fn?: string, code?: string }} command
 */
export function describeCommand(command) {
  switch (command.kind) {
    case "click": return `click ${command.controlId}`
    case "call": return `call ${command.module}#${command.fn}`
    case "run": return `run ${command.file}${command.exportName ? `#${command.exportName}` : ""}`
    case "eval": return `eval ${String(command.code).slice(0, 60)}`
    default: return String(command.kind)
  }
}
