/**
 * 类型声明（实现见 src/vite-plugin.js）。
 *
 * 这里刻意不复用 vite 的 `Plugin` 类型：那样没装 vite 类型的项目会连声明都读不了，
 * 而这个对象结构上就是 vite 插件认的（name + apply + 钩子）。
 */

import type { BridgeOptions } from "./server.js"

export interface WpsDebugBridgePlugin {
  name: string
  apply: "serve"
  configureServer(server: any): void
  transformIndexHtml(): unknown[]
}

/**
 * 桥的 vite 插件：只在 `vite dev` 生效（`apply: "serve"`），
 * 生产构建里不会包含任何桥的代码。
 *
 * ```ts
 * export default defineConfig({ plugins: [wpsDebugBridge()] })
 * ```
 */
export function wpsDebugBridge(options?: BridgeOptions): WpsDebugBridgePlugin

export type { BridgeOptions }
export default wpsDebugBridge
