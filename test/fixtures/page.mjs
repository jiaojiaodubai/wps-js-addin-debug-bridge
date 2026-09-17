/**
 * WPS 加载项页面模拟器（只给测试用）。
 *
 * 桥的页面侧客户端（src/client.js）本来跑在 WPS 内嵌的浏览器里。这里给它一副最小可用的
 * “宿主”替身，然后**真的加载 src/client.js**，让它照常长轮询、在页面里执行命令、回传结果：
 *
 *   - DOM 垫片：window / document / location / navigator / alert / fetch（相对地址解析）；
 *   - WPS 宿主垫片：Application / wps（PluginStorage、ribbonUI、文档对象……）；
 *   - 模块解析垫片：resolve-root.mjs 把 dev server 的 URL 映射到磁盘文件；
 *   - 页面代码：classic 脚本用 vm 跑（顶层 function 才会变成全局函数，
 *     等价于浏览器里的 <script src>），模块入口用 import 加载。
 *
 * 于是 test/examples.test.js 能在**不装 WPS** 的情况下，验证 examples/ 里三个加载项
 * 的入口能不能点、测试模块能不能跑、报告行能不能被桥解析。
 *
 * 用法：
 *   node test/fixtures/page.mjs --port 3889 --root <加载项目录> --app wps|et|wpp \
 *     [--scripts js/util.js,js/ribbon.js] [--module src/main.ts]
 */

import { readFile } from "node:fs/promises"
import { register } from "node:module"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, "../../src/client.js")

function parseArgv(argv) {
  const options = { port: 3889, root: process.cwd(), app: "wps", scripts: [], module: "" }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, "")
    const value = argv[index + 1]
    if (key === "port") options.port = Number(value)
    else if (key === "scripts") options.scripts = value.split(",").map(item => item.trim()).filter(Boolean)
    else options[key] = value
  }
  return options
}

const options = parseArgv(process.argv.slice(2))
const pageUrl = `http://127.0.0.1:${options.port}/index.html`

/**
 * WPS 宿主替身：只实现示例用到的接口。
 * 三个组件的文档对象各按自己的对象模型来（Word / Excel / PowerPoint 兼容）。
 */
function createHost(app) {
  const storage = new Map()
  const host = {
    PluginStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    ribbonUI: { InvalidateControl() {}, Invalidate() {} },
    OAAssist: { WebNotify: text => console.log(`[webNotify] ${text}`) },
  }

  if (app === "wps") {
    host.ActiveDocument = { Name: "HelloBridge.docx", Content: { Text: "" } }
  }
  else if (app === "et") {
    const cells = new Map()
    host.ActiveWorkbook = {
      Name: "HelloBridge.xlsx",
      ActiveSheet: {
        Range(address) {
          if (!cells.has(address)) cells.set(address, { Value2: "" })
          return cells.get(address)
        },
      },
    }
  }
  else {
    const title = { Text: "" }
    host.ActivePresentation = {
      Name: "HelloBridge.pptx",
      Slides: {
        Count: 1,
        Item: () => ({ Shapes: { Title: { TextFrame: { TextRange: title } } } }),
      },
    }
  }

  return host
}

function installGlobals() {
  const nodeFetch = globalThis.fetch

  globalThis.window = globalThis
  globalThis.location = { href: pageUrl, toString: () => pageUrl }
  globalThis.document = { title: "WPS 加载项（测试模拟页面）", location: globalThis.location, write() {} }
  globalThis.alert = text => console.log(`[alert] ${text}`)
  // navigator 在 Node 里是只读的 getter，得用 defineProperty 换成页面的那份
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: `wps-page-simulator node/${process.versions.node}` },
    configurable: true,
    writable: true,
  })

  // 浏览器里 fetch 的相对地址按页面地址解析；Node 的 fetch 只接受绝对地址
  globalThis.fetch = (input, init) => nodeFetch(typeof input === "string" ? new URL(input, pageUrl) : input, init)

  globalThis.Application = createHost(options.app)
  globalThis.wps = {
    WpsApplication: () => globalThis.Application,
    EtApplication: () => globalThis.Application,
    WppApplication: () => globalThis.Application,
  }

  // 桥的页面侧客户端从这两个全局读配置（真实页面里由 dev server 注入）
  globalThis.__wpsDebugBridgeOptions = {
    readyCheck: "typeof window.OnAction === 'function'",
    readyTimeoutMs: 15_000,
  }
}

/** 加载示例的页面代码。 */
async function loadPageCode() {
  for (const relative of options.scripts) {
    const file = path.join(options.root, relative)
    const source = await readFile(file, "utf8")
    // 等价于浏览器的 <script src>：顶层 function 会成为全局函数（OnAction 等）
    vm.runInThisContext(source, {
      filename: file,
      importModuleDynamically: specifier => import(specifier),
    })
  }

  if (options.module) {
    await import(pathToFileURL(path.join(options.root, options.module)).href)
  }
}

installGlobals()

// 注册模块解析钩子：之后 client.js 里那些 dev server 风格的地址才能落到磁盘文件上
register("./resolve-root.mjs", import.meta.url, { data: { root: options.root } })

await loadPageCode()
console.log(`[page] ${options.app} 页面已就绪（root=${options.root}），正在接入桥…`)

// 最后加载页面侧客户端：它会开始长轮询，等桥下发命令
await import(pathToFileURL(CLIENT_PATH).href)
