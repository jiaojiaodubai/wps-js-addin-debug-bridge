/**
 * 桥的 HTTP 适配层：把 src/bridge.js 的核心接到任意 Node HTTP 服务上。
 *
 * vite 用户直接用 `wpsDebugBridge()`（src/vite-plugin.js）；别的 dev server
 * （esbuild、webpack、自写的静态服务……）挂这个中间件即可，见 examples/。
 *
 * 这一层负责四件事：
 *   1. 路由：/__wps_debug_bridge/api/* 与两个页面侧脚本；
 *   2. 把关：只接受本机来源的请求（防恶意网页与 DNS rebinding），可选再要一个 token；
 *   3. 落地：把“我在哪个端口”写进 .wps-bridge.json，终端侧据此自动找到桥和 token；
 *   4. 注入：往我们自己下发的 HTML 里塞页面侧客户端。
 */

import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { createBridge } from "./bridge.js"
import { createLogger } from "./logger.js"
import {
  API_PREFIX,
  BRIDGE_PREFIX,
  CLIENT_SCRIPT_PATH,
  CLIENT_SCRIPT_URL,
  DEFAULT_PORT_FILE,
  POLL_TIMEOUT_MS,
  PROTOCOL_MODULE_PATH,
  PROTOCOL_VERSION,
} from "./protocol.js"

// 端口文件的位置/格式是终端侧也要用的约定，所以常量放在 protocol.js 里
export { DEFAULT_PORT_FILE }

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 注入到页面的选项全局对象名，客户端（src/client.js）从这里读配置。 */
export const CLIENT_OPTIONS_GLOBAL = "__wpsDebugBridgeOptions"

/** 页面就绪判定：默认等 WPS 加载项把 Ribbon 回调挂到 window 上。 */
export const DEFAULT_READY_CHECK = "typeof window.OnAction === 'function'"

/** 只有这两个文件允许被页面加载，避免把包的其余内容暴露给 dev server。 */
const SERVED_FILES = new Map([
  [CLIENT_SCRIPT_PATH, "client.js"],
  [PROTOCOL_MODULE_PATH, "protocol.js"],
])

/** 从 Host 头里取端口（`127.0.0.1:3889`、`[::1]:3889` 都认）。 */
export function portFromHost(host = "") {
  const index = String(host).lastIndexOf(":")
  if (index === -1) return 0
  const port = Number(String(host).slice(index + 1))
  return Number.isInteger(port) && port > 0 ? port : 0
}

/** 主机名是不是本机（含 IPv6 的 [::1] 与整段 127.0.0.0/8）。 */
export function isLoopbackHost(host = "") {
  const hostname = String(host).replace(/:\d+$/, "").toLowerCase()
  return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127\./.test(hostname)
}

/**
 * 默认放行规则，两条：
 *   1. `Host` 必须是本机地址 —— 否则局域网/公网的请求（以及 DNS rebinding 之后
 *      伪装成别的域名打过来的请求）都能调用“能执行任意 JS”的桥接口；
 *   2. 带 `Origin` 时（浏览器发的跨站请求一定带），必须与 Host 同源 ——
 *      本机页面自己发的是同源请求，恶意网页发来的一定不同源。
 *
 * 需要从别的机器连（例如远程调试）时，用 `originGuard` 自定义，或显式关掉。
 */
export function defaultOriginGuard({ host = "", origin = "" } = {}) {
  if (!isLoopbackHost(host)) return false
  if (!origin) return true
  try {
    return new URL(origin).host === host
  }
  catch {
    return false
  }
}

/**
 * 生成注入到 HTML 里的页面侧选项（插件与其它 dev server 共用）。
 * @param {{ readyCheck?: string, readyTimeoutMs?: number, commandTimeoutMs?: number, heartbeatMs?: number, token?: string }} [options]
 */
export function bridgeClientOptions(options = {}) {
  const clientOptions = {
    readyCheck: options.readyCheck ?? DEFAULT_READY_CHECK,
    readyTimeoutMs: options.readyTimeoutMs,
    commandTimeoutMs: options.commandTimeoutMs,
    heartbeatMs: options.heartbeatMs,
  }
  if (options.token) clientOptions.token = options.token
  return clientOptions
}

/**
 * 页面侧的两段注入脚本：先设置选项，再加载客户端模块。
 * 非 vite 的 dev server 把它拼进 HTML 即可（也可用 injectBridgeClient）。
 * @param {{ readyCheck?: string, readyTimeoutMs?: number, commandTimeoutMs?: number, heartbeatMs?: number, token?: string }} [options]
 */
export function bridgeClientTags(options = {}) {
  return `<script>window.${CLIENT_OPTIONS_GLOBAL} = ${JSON.stringify(bridgeClientOptions(options))}</script>`
    + `\n<script type="module" src="${CLIENT_SCRIPT_URL}"></script>`
}

/**
 * 把页面侧客户端注入 HTML（改成 `</body>` 前，没有 body 就追加到末尾）。
 * @param {string} html
 * @param {{ readyCheck?: string, readyTimeoutMs?: number, commandTimeoutMs?: number, heartbeatMs?: number, token?: string }} [options]
 */
export function injectBridgeClient(html, options = {}) {
  const tags = bridgeClientTags(options)
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tags}\n</body>`) : `${html}\n${tags}\n`
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("error", reject)
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      }
      catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * 创建一个 connect 风格的中间件（`(request, response, next)`）。
 *
 * @param {object} [options]
 * @param {boolean} [options.log] 是否打印页面请求（也可用环境变量 WPS_BRIDGE_LOG=1）
 * @param {boolean} [options.quiet] 是否只打印错误
 * @param {string} [options.readyCheck] 页面就绪判定的 JS 表达式
 * @param {number} [options.readyTimeoutMs] 等待页面就绪的上限
 * @param {number} [options.commandTimeoutMs] 单条命令在页面里的执行上限
 * @param {number} [options.heartbeatMs] 页面侧信标间隔（ms），默认 5000
 * @param {number} [options.blockedAfterMs] 信标/主线程多久没动静算异常（ms），默认 15000
 * @param {string|boolean} [options.token] 是否要求页面/终端带上 token（`true` 为随机生成）
 * @param {(context: { host: string, origin: string }) => boolean} [options.originGuard] 自定义放行规则
 * @param {string|false} [options.portFile] 端口/token 落地文件，默认项目目录下的 .wps-bridge.json
 * @param {number} [options.eventBufferSize] 事件日志容量
 * @param {number} [options.maxQueuedCommands] 命令队列上限
 */
export function createBridgeMiddleware(options = {}) {
  const logger = options.logger ?? createLogger({ quiet: options.quiet ?? false })
  const bridge = createBridge(options)
  const token = options.token === true ? randomUUID() : String(options.token ?? "")
  const guard = options.originGuard ?? defaultOriginGuard
  const portFilePath = options.portFile === false
    ? ""
    : path.resolve(String(options.portFile ?? DEFAULT_PORT_FILE))
  const logRequests = options.log ?? Boolean(process.env.WPS_BRIDGE_LOG)
  const clientOptions = { ...options, token }

  let announced = null

  async function writePortFile() {
    if (!portFilePath || !announced) return
    try {
      await writeFile(portFilePath, `${JSON.stringify(announced, null, 2)}\n`, "utf8")
    }
    catch (error) {
      logger.warn(`写不了端口文件 ${portFilePath}：${error.message}`)
    }
  }

  /**
   * 告诉桥“我在这个端口上”。接着它会把端口与 token 写进 .wps-bridge.json，
   * 终端侧就能自动找到桥（免得 5173/3889 对不上号）。
   */
  function announce(port) {
    if (!port) return
    announced = {
      protocol: PROTOCOL_VERSION,
      port: Number(port),
      token: token || null,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    writePortFile()
  }

  async function removePortFile() {
    if (!portFilePath || !announced) return
    try {
      const current = JSON.parse(await readFile(portFilePath, "utf8"))
      // 只清理自己写的：同一个目录里可能还跑着另一个 dev server
      if (current.pid === process.pid) await rm(portFilePath, { force: true })
    }
    catch {
      // 文件不在了就算了
    }
  }

  function sendJson(response, status, payload) {
    response.statusCode = status
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.end(JSON.stringify(payload))
  }

  async function serveAsset(response, file) {
    const body = await readFile(path.join(SOURCE_DIR, file), "utf8")
    response.statusCode = 200
    response.setHeader("Content-Type", "application/javascript; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.end(body)
  }

  async function handleApi(action, request, response, url) {
    const clientId = url.searchParams.get("client") ?? undefined

    switch (action) {
      case "status": {
        sendJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION, ...bridge.status() })
        return
      }

      case "poll": {
        // 长轮询本身也是心跳：超时返回空命令，客户端立刻再轮询。
        bridge.record({ type: "seen", clientId })
        // 页面刷新会直接断掉连接：用 AbortSignal 释放等待位，
        // 否则命令会被交给一个已经消失的客户端（表现为“命令下发了但没人执行”）。
        const controller = new AbortController()
        const onClose = () => controller.abort()
        request.on("close", onClose)
        const command = await bridge.waitForCommand(clientId, { timeoutMs: POLL_TIMEOUT_MS, signal: controller.signal })
        request.off("close", onClose)
        sendJson(response, 200, { command: command ?? null })
        return
      }

      case "submit": {
        const body = await readJsonBody(request)
        // 只转发已知字段：页面侧按字段名取用，拼错/漏传会直接表现为“字段 undefined”。
        const result = bridge.submit({
          id: body.id ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: body.kind,
          controlId: body.controlId,
          module: body.module,
          fn: body.fn,
          file: body.file,
          exportName: body.exportName,
          args: body.args,
          code: body.code,
          useHook: body.useHook !== false,
        }, { clientId: body.clientId ?? undefined })

        if (!result.ok) {
          sendJson(response, 429, result)
          return
        }
        sendJson(response, 200, result)
        return
      }

      case "report": {
        const body = await readJsonBody(request)
        const event = { ...(body.event ?? body), clientId: body.client ?? clientId }
        if (event.type === "hello" && event.protocol !== PROTOCOL_VERSION) {
          // 页面是旧版本的客户端（多半是 dev server 重启过、加载项页面没重新加载）
          event.protocolMismatch = true
        }
        const record = bridge.record(event)
        if (event.type === "hello") {
          if (event.protocolMismatch) {
            logger.warn(`页面用的是旧版客户端（协议 ${event.protocol ?? "未知"}，当前 ${PROTOCOL_VERSION}）`)
          }
          else {
            logger.info(`页面已接入：${event.clientId}`)
          }
        }
        sendJson(response, 200, { ok: true, seq: record?.seq ?? null })
        return
      }

      case "events": {
        const since = Number(url.searchParams.get("since") ?? "0")
        const events = await bridge.waitForEvents(since, POLL_TIMEOUT_MS)
        sendJson(response, 200, { events, seq: bridge.events.latestSeq, droppedBefore: bridge.events.droppedBefore })
        return
      }

      case "reset": {
        bridge.reset()
        sendJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION })
        return
      }

      default: {
        sendJson(response, 404, { ok: false, error: `未知的桥接口：${action}` })
      }
    }
  }

  async function handle(request, response, next) {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (!url.pathname.startsWith(BRIDGE_PREFIX)) {
      if (typeof next === "function") {
        next()
        return
      }
      response.statusCode = 404
      response.end("not found")
      return
    }

    if (logRequests) logger.info(`${request.method} ${request.url}`)

    // 还没 announce 过，就借第一个请求的 Host 补上（自写的 dev server 可以不写 announce）
    if (!announced) announce(portFromHost(request.headers.host))

    if (SERVED_FILES.has(url.pathname)) {
      await serveAsset(response, SERVED_FILES.get(url.pathname))
      return
    }

    const host = String(request.headers.host ?? "")
    const origin = String(request.headers.origin ?? "")
    if (!guard({ host, origin })) {
      sendJson(response, 403, {
        ok: false,
        error: `拒绝来自 ${origin || host} 的请求：桥只接受本机同源调用（需要远程访问就自定义 originGuard）`,
      })
      return
    }

    if (token) {
      const provided = request.headers["x-wps-bridge-token"] ?? url.searchParams.get("token") ?? ""
      if (provided !== token) {
        sendJson(response, 401, { ok: false, error: "缺少或不匹配的 token（页面由 dev server 注入，终端见 --token / .wps-bridge.json）" })
        return
      }
    }

    const action = url.pathname.slice(API_PREFIX.length).replace(/^\//, "")
    try {
      await handleApi(action, request, response, url)
    }
    catch (error) {
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return {
    handle,
    announce,
    status: () => bridge.status(),
    async dispose() {
      bridge.dispose()
      await removePortFile()
    },
  }
}

export default createBridgeMiddleware
