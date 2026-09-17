import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, type Plugin } from "vite"

import { wpsDebugBridge } from "wps-js-addin-debug-bridge"

const ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 发布时要一起打进 dist 的文件：vite 只管 index.html 与它引用的资源。 */
const ADDIN_FILES = ["manifest.xml", "ribbon.xml"]

function copyAddinFiles(): Plugin {
  return {
    name: "copy-addin-files",
    apply: "build",
    closeBundle() {
      const outDir = path.join(ROOT, "dist")
      mkdirSync(outDir, { recursive: true })
      for (const file of ADDIN_FILES) {
        const from = path.join(ROOT, file)
        if (existsSync(from)) copyFileSync(from, path.join(outDir, file))
      }
    },
  }
}

export default defineConfig({
  base: "./",
  plugins: [
    // 桥：只在 `vite dev` 生效（apply: "serve"），生产构建里不会包含任何桥代码
    wpsDebugBridge(),
    copyAddinFiles(),
  ],
  server: {
    // 3889 与官方 wpsjs 模板一致。桥会把实际端口写进 .wps-bridge.json，
    // 终端侧自动读，所以命令行不用再写 --port。
    port: 3889,
    // 官方模板用 0.0.0.0，方便从别的机器看页面；但桥只接受本机同源调用，
    // 从别的机器打开时页面连不上桥（真要那样用就自定义 originGuard）
    host: "0.0.0.0",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
