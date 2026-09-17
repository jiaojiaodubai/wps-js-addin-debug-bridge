/**
 * 发布构建：把入口打包成 dist/js/main.js，并拷贝加载项所需的静态文件。
 *
 * 用法：npm run build
 *
 * 注意：构建产物里**没有**任何桥的代码 —— 桥只在 dev-server.js 里存在。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, "dist")

/** WPS 加载项离线部署时需要的静态文件。 */
const STATIC_FILES = ["manifest.xml", "ribbon.xml"]

mkdirSync(path.join(DIST, "js"), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(ROOT, "src", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  outfile: path.join(DIST, "js", "main.js"),
  logLevel: "info",
})

for (const file of STATIC_FILES) {
  const from = path.join(ROOT, file)
  if (existsSync(from)) copyFileSync(from, path.join(DIST, file))
}

// index.html：把开发用的 /src/main.ts 换成构建产物，并改成相对路径
const html = readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace("/src/main.ts", "./js/main.js")
writeFileSync(path.join(DIST, "index.html"), html)

console.info(`[build] 已产出：${DIST}`)
