/**
 * ESM 解析钩子：把“dev server 的 URL”映射到磁盘文件（只给测试用）。
 *
 * 真实运行时，页面里的模块地址是由 dev server 解析并编译的：
 *   `/test/hello.test.ts`  → 项目根下的 test/hello.test.ts（.ts 由 dev server 编译）
 *   `/@fs/C:/x/y.ts`       → 项目外的绝对路径（vite 的写法）
 *   `./ribbon`             → 由打包器补上扩展名
 *
 * Node 里没有 dev server，于是这个钩子扮演它，让 src/client.js 能原样在 Node 里跑起来
 * （TypeScript 由 Node 22.18+ 原生类型擦除处理，见 examples 的说明）。
 *
 * 钩子在独立线程里执行，拿不到主线程的变量，所以 root 通过 register() 的 data 传入。
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** 等价于打包器的扩展名补全顺序。 */
const EXTENSIONS = [".ts", ".js", ".mjs", ".json"]

const FS_PREFIX = "/@fs/"
const ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

let root = process.cwd()

/** 由 register(specifier, parentURL, { data }) 传入。 */
export function initialize(data) {
  if (data && typeof data.root === "string") root = data.root
}

export async function resolve(specifier, context, nextResolve) {
  // 查询串要留着（`?t=...` 是 --fresh 的 cache-busting，Node 会把带查询串的 URL 当成另一个模块），
  // 但落到磁盘上时得先摘掉它。
  const [target, search] = splitQuery(specifier)
  const suffix = search ? `?${search}` : ""

  // ① vite 的 /@fs/：直接就是磁盘路径
  if (target.startsWith(FS_PREFIX)) {
    const file = decodeURIComponent(target.slice(FS_PREFIX.length))
    return { url: `${pathToFileURL(ABSOLUTE_PATH.test(file) ? file : `/${file}`).href}${suffix}`, shortCircuit: true }
  }

  // ② dev server 的项目内路径
  if (target.startsWith("/")) {
    const file = path.join(root, decodeURIComponent(target.slice(1)))
    return { url: `${pathToFileURL(file).href}${suffix}`, shortCircuit: true }
  }

  // ③ 不带扩展名的相对路径：先按 Node 的规矩来，失败就依次补扩展名（打包器的行为）
  if (target.startsWith("./") || target.startsWith("../")) {
    try {
      return await nextResolve(specifier, context)
    }
    catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL) throw error
      const base = new URL(target, context.parentURL)
      for (const extension of EXTENSIONS) {
        const candidate = new URL(`${base.href}${extension}${suffix}`)
        if (fs.existsSync(fileURLToPath(new URL(`${base.href}${extension}`)))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }

  return nextResolve(specifier, context)
}

function splitQuery(specifier) {
  const index = specifier.indexOf("?")
  return index === -1 ? [specifier, ""] : [specifier.slice(0, index), specifier.slice(index + 1)]
}
