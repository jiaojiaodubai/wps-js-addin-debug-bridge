/**
 * 开发服务器：esbuild（按需打包）+ 桥中间件。
 *
 * 这个示例演示：**桥也不绑定 vite**。esbuild 只负责把 TS 变成浏览器能跑的 ESM，
 * 页面由这个几十行的 Node 服务发出去，桥通过 `wps-js-addin-debug-bridge/server`
 * 的 `createBridgeMiddleware()` 挂上，再由 `injectBridgeClient()` 注入页面侧客户端。
 *
 * 用法：
 *   npm run dev              # 默认 http://127.0.0.1:3889
 *   PORT=3900 npm run dev    # 换端口（桥那边要对应 --port 3900）
 */

import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3889)

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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
 * 把一个 .ts 按需打包成一份 ESM 交给页面。
 *
 * 用 bundle 而不是 transform：单文件转译不改写 import 路径（`./ribbon` 得变成
 * `./ribbon.js` 才能被浏览器加载），把入口交给 esbuild 一起处理最省事。
 * 页面里的 `/src/main.ts`、`/test/hello.test.ts` 都是这样按需编译的。
 */
async function bundleTs(entryPath) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    sourcemap: "inline",
    write: false,
    logLevel: "silent",
  })
  return result.outputFiles[0].text
}

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

      if (filePath.endsWith(".ts")) {
        response.setHeader("Content-Type", MIME_TYPES[".js"])
        response.end(await bundleTs(filePath))
        return
      }

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
    catch (error) {
      console.error(`[dev] ${request.url} 失败：${error.message}`)
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
