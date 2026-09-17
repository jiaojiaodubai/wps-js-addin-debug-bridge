/**
 * 桥的服务端：一个只会作用于 `vite dev`（apply: "serve"）的 vite 插件。
 *
 * 背景：WPS 加载项运行在宿主注入的 Chromium 内核里，没有对外的 JS 求值通道
 * （CEF 远程调试端口由宿主自己拉起，自定义 Ribbon 按钮也不在 COM 的 CommandBars 里），
 * 但开发模式下加载项页面由本机 dev server 提供 —— 于是可以往“我们自己下发的页面”里
 * 注入一个客户端脚本，由它代为执行触发与调用，再通过 HTTP 长轮询与终端通信。
 *
 * 真正的服务端逻辑（命令队列、事件日志、HTTP 接口）在 src/server.js：
 * 本文件只把它接到 vite 上。用别的 dev server（webpack/rollup/esbuild/自写的静态服务）
 * 时直接挂 src/server.js 里的 `createBridgeMiddleware()` 即可，见 examples/。
 */

import { BRIDGE_PREFIX, CLIENT_SCRIPT_URL } from "./protocol.js"
import { CLIENT_OPTIONS_GLOBAL, bridgeClientOptions, createBridgeMiddleware } from "./server.js"

/**
 * @param {object} [options]
 * @param {boolean} [options.log] 是否打印页面请求（也可用环境变量 WPS_BRIDGE_LOG=1）
 * @param {boolean} [options.quiet] 是否只打印错误
 * @param {string} [options.readyCheck] 页面就绪判定的 JS 表达式，默认等 WPS 加载项的 Ribbon 回调
 * @param {number} [options.readyTimeoutMs] 等待页面就绪的上限，默认 90000
 * @param {number} [options.commandTimeoutMs] 单条命令在页面里的执行上限，默认 120000
 * @param {number} [options.heartbeatMs] 页面侧信标间隔（ms），默认 5000
 * @param {number} [options.blockedAfterMs] 信标/主线程多久没动静算异常（ms），默认 15000
 * @param {string|boolean} [options.token] 是否要求页面/终端带上 token（`true` 为随机生成）
 * @param {(context: { host: string, origin: string }) => boolean} [options.originGuard] 自定义放行规则
 * @param {string|false} [options.portFile] 端口/token 落地文件，默认项目目录下的 .wps-bridge.json
 */
export function wpsDebugBridge(options = {}) {
  const bridge = createBridgeMiddleware(options)

  return {
    name: "wps-js-addin-debug-bridge",
    apply: "serve",

    configureServer(server) {
      server.middlewares.use(bridge.handle)
      // 端口就绪后写 .wps-bridge.json：终端侧不用再猜 3889 / 5173
      server.httpServer?.once("listening", () => bridge.announce(server.httpServer?.address()?.port))
      server.httpServer?.on("close", () => bridge.dispose())
      console.info(`[wps-bridge] 已挂载：${BRIDGE_PREFIX}（等待页面接入）`)
    },

    transformIndexHtml() {
      return [
        {
          tag: "script",
          children: `window.${CLIENT_OPTIONS_GLOBAL} = ${JSON.stringify(bridgeClientOptions(options))}`,
          injectTo: "head-prepend",
        },
        {
          tag: "script",
          attrs: { type: "module", src: CLIENT_SCRIPT_URL },
          injectTo: "body",
        },
      ]
    },
  }
}

export default wpsDebugBridge
