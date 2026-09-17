/**
 * 手写的 .d.ts 容易和实现走样，这里盯着两边的导出。
 *
 * 只检查“运行时应该有”的部分（函数/常量/默认导出）；interface / type 之类
 * 本来就只存在于类型里，跳过。
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import * as pluginModule from "../src/vite-plugin.js"
import * as serverModule from "../src/server.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 从 .d.ts 里抠出运行时应该存在的导出名。 */
function declaredRuntimeExports(source) {
  const names = new Set()
  for (const match of source.matchAll(/^export (?:declare )?(?:function|const|let|class) (\w+)/gm)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const name of match[1].split(",")) names.add(name.trim())
  }
  return [...names]
}

async function readDeclaration(file) {
  return readFile(path.join(HERE, "..", "src", file), "utf8")
}

test("类型声明与实现一致：vite 插件", async () => {
  const declared = declaredRuntimeExports(await readDeclaration("vite-plugin.d.ts"))
  assert.deepEqual(declared, ["wpsDebugBridge"], "插件只应该对外暴露这一个函数")
  for (const name of declared) {
    assert.equal(typeof pluginModule[name], "function", `声明了 ${name}，实现里应当是函数`)
  }
  assert.equal(typeof pluginModule.default, "function", "应当有默认导出")
})

test("类型声明与实现一致：服务端", async () => {
  const declared = declaredRuntimeExports(await readDeclaration("server.d.ts"))
  assert.ok(declared.length > 0)

  for (const name of declared) {
    assert.ok(name in serverModule, `.d.ts 声明了 ${name}，实现里却没有`)
  }
  // default 单独检查（它在命名空间对象里也是一个 key）
  for (const name of Object.keys(serverModule).filter(key => key !== "default")) {
    assert.ok(declared.includes(name), `实现里导出了 ${name}，但 .d.ts 没声明`)
  }
  assert.equal(typeof serverModule.default, "function", "应当有默认导出")
})
