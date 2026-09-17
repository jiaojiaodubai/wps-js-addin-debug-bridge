/**
 * 开发服务器：零依赖（只用 Node 内置模块）+ 调试桥中间件。
 *
 * 纯 JS 的加载项不需要打包，所以这个示例刻意不用 vite —— 正好说明**桥不绑定 vite**：
 * 任何能把项目页面发出去的 HTTP 服务，挂上 `createBridgeMiddleware()` 并往 HTML 里
 * 注入 `injectBridgeClient()` 就能接入。
 * （vite 版本见 examples/wps-et-ts-vite，esbuild 版本见 examples/wps-wpp-ts-esbuild。）
 *
 * 用法：
 *   npm run dev              # 默认 http://127.0.0.1:3889
 *   PORT=3900 npm run dev    # 换端口（桥那边要对应 --port 3900）
 */

import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3889)

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".svg": "image/svg+xml",
}

const bridge = createBridgeMiddleware({
  // 页面就绪判定：等加载项把 Ribbon 回调挂到 window 上再算接入（这也就是默认值）
  readyCheck: "typeof window.OnAction === 'function'",
})

/**
 * 把 URL 路径映射到项目目录下的文件，顺带挡住目录穿越。
 *
 * `/@fs/<绝对路径>` 是“项目外的文件”的约定（vite 起的头）：桥的 `run ../shared/perf.ts`
 * 会解析成这个形状。默认只允许项目目录的上一级，要放宽就改 FS_ALLOW。
 */
const FS_PREFIX = "/@fs/"
const FS_ALLOW = path.dirname(ROOT)

/** Windows 上盘符大小写不一致是常事（`c:\x` vs `C:\x`），比较时得忽略大小写。 */
function isInside(parent, target) {
  const [base, candidate] = process.platform === "win32"
    ? [parent.toLowerCase(), target.toLowerCase()]
    : [parent, target]
  return candidate.startsWith(base + path.sep)
}

function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.startsWith(FS_PREFIX)) {
    const absolute = path.resolve(decoded.slice(FS_PREFIX.length))
    return isInside(FS_ALLOW, absolute) ? absolute : null
  }

  const relative = decoded.replace(/^\/+/, "")
  const filePath = path.join(ROOT, relative)
  if (filePath !== ROOT && !isInside(ROOT, filePath)) return null
  return filePath
}

function notFound(response) {
  response.statusCode = 404
  response.end("Not Found")
}

const server = createServer((request, response) => {
  // 先给桥：只有 /__wps_debug_bridge 开头的请求会被它接走，其余交给后面的静态服务
  bridge.handle(request, response, async () => {
    try {
      let filePath = resolveFile(new URL(request.url, "http://localhost").pathname)
      if (!filePath) return notFound(response)

      const info = await stat(filePath).catch(() => null)
      if (info?.isDirectory()) filePath = path.join(filePath, "index.html")

      const body = await readFile(filePath)
      if (filePath.endsWith(".html")) {
        // 关键一步：往我们自己下发的页面里注入页面侧客户端
        response.setHeader("Content-Type", MIME_TYPES[".html"])
        response.end(injectBridgeClient(body.toString("utf8")))
        return
      }

      response.setHeader("Content-Type", MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream")
      response.end(body)
    }
    catch {
      notFound(response)
    }
  })
})

server.listen(PORT, () => {
  console.info(`[dev] 加载项页面：http://127.0.0.1:${PORT}/`)
  console.info("[dev] 调试桥已挂载：/__wps_debug_bridge（等加载项页面接入）")
  // 把端口写进 .wps-bridge.json：终端侧就不用再猜端口了
  bridge.announce(PORT)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.dispose()
    server.close(() => process.exit(0))
  })
}