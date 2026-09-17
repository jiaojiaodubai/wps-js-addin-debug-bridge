/**
 * 类型声明（实现见 src/server.js）。
 *
 * 手写而不是从 JSDoc 生成：这层 API 很小、要长期稳定，生成器反而会把内部结构抖出来。
 * test/types.test.js 会盯着两边的导出别走样。
 */

export type OriginGuardContext = {
  /** 请求的 Host 头（含端口）。 */
  host: string
  /** 请求的 Origin 头；终端这类非浏览器客户端不带。 */
  origin: string
}

export interface BridgeLogger {
  info(text: string): void
  warn(text: string): void
  error(text: string): void
  raw(text: string): void
}

export interface BridgeOptions {
  /** 打印页面请求（也可用环境变量 WPS_BRIDGE_LOG=1）。 */
  log?: boolean
  /** 只打印错误。 */
  quiet?: boolean
  logger?: BridgeLogger
  /** 页面就绪判定的 JS 表达式，默认等加载项把 Ribbon 回调挂到 window 上。 */
  readyCheck?: string
  /** 等待页面就绪的上限（ms），默认 90000。 */
  readyTimeoutMs?: number
  /** 单条命令在页面里的执行上限（ms），默认 120000。 */
  commandTimeoutMs?: number
  /** 是否要求页面/终端带上 token（`true` 为随机生成），默认关闭。 */
  token?: string | boolean
  /** 自定义放行规则；默认只接受本机同源请求。 */
  originGuard?: (context: OriginGuardContext) => boolean
  /** 端口/token 落地文件，默认项目目录下的 .wps-bridge.json；`false` 关闭。 */
  portFile?: string | false
  /** 事件日志容量，默认 5000。 */
  eventBufferSize?: number
  /** 命令队列上限，默认 1000。 */
  maxQueuedCommands?: number
  /** 客户端空闲多久算断开（ms），默认 45000。 */
  clientTtlMs?: number
  /** 多久没有心跳算被卡住（ms），默认 5000。 */
  blockedAfterMs?: number
}

export interface BridgeClientOptions {
  readyCheck: string
  readyTimeoutMs?: number
  commandTimeoutMs?: number
  token?: string
}

export interface ClientStatus {
  id: string
  /** idle：空闲；busy：正在执行；blocked：执行中心跳停了（多半被宿主弹窗冻结）。 */
  state: "idle" | "busy" | "blocked"
  idleMs: number
  busyCommandId: string | null
  busyMs: number
}

export interface BridgeStatus {
  clients: ClientStatus[]
  queuedCommands: number
  queued: Array<{ id: string, kind: string, clientId: string | null }>
  eventSeq: number
  droppedBefore: number
}

/** connect 风格的中间件：`(request, response, next)`；没接管的请求会走 next()。 */
export type BridgeMiddleware = (request: any, response: any, next?: () => void) => Promise<void>

export interface BridgeHandle {
  handle: BridgeMiddleware
  /** 告诉桥“我在这个端口上”，顺带把端口与 token 写进端口文件。 */
  announce(port: number): void
  status(): BridgeStatus
  /** 释放挂着的长轮询，并收走自己写的端口文件。 */
  dispose(): Promise<void>
}

/**
 * 创建一个与构建工具无关的桥中间件。
 *
 * ```js
 * const bridge = createBridgeMiddleware()
 * http.createServer((request, response) => bridge.handle(request, response, serveStatic))
 * ```
 */
export function createBridgeMiddleware(options?: BridgeOptions): BridgeHandle

/** 把页面侧客户端注入 HTML（改成 `</body>` 前，没有 body 就追加到末尾）。 */
export function injectBridgeClient(html: string, options?: BridgeOptions): string

/** 页面侧的两段注入脚本（自己拼 HTML 时用）。 */
export function bridgeClientTags(options?: BridgeOptions): string

/** 生成注入到页面里的客户端选项。 */
export function bridgeClientOptions(options?: BridgeOptions): BridgeClientOptions

/** 主机名是不是本机（含 `[::1]` 与整段 127.0.0.0/8）。 */
export function isLoopbackHost(host: string): boolean

/** 从 Host 头里取端口，取不到返回 0。 */
export function portFromHost(host: string): number

/** 默认放行规则：Host 必须是本机地址，且带 Origin 时必须同源。 */
export function defaultOriginGuard(context: OriginGuardContext): boolean

export const DEFAULT_READY_CHECK: string
export const DEFAULT_PORT_FILE: string

/** 注入到页面的选项全局对象名（`window.__wpsDebugBridgeOptions`）。 */
export const CLIENT_OPTIONS_GLOBAL: string

export default createBridgeMiddleware
