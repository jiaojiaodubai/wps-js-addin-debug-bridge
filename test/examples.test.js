/**
 * 用 examples/ 里的三个加载项示例跑桥的端到端测试。
 *
 * 这三个示例分别在 WPS 文字 / 表格 / 演示上，用三种技术栈（纯 JS、TS+Vite、TS+esbuild）
 * 接入了桥。这里把它们真的跑起来：
 *
 *   1. 起一个“dev server 的最小骨架”：桥中间件（src/server.js）挂在裸 http 服务上；
 *   2. 起一个页面模拟器（test/fixtures/page.mjs）：装上 WPS 宿主替身，加载示例的页面代码，
 *      再真的加载 src/client.js，让它照常长轮询、执行命令、回传结果；
 *   3. 用桥的终端侧（src/runner.js）下发命令，断言退出码与输出。
 *
 * 于是**不需要安装 WPS**也能覆盖到：服务端接口、页面侧客户端、终端侧运行器、
 * 以及三个示例的 Ribbon 入口与测试模块。
 *
 * 说明：这里不启动示例自带的 dev server（wps-et-ts-vite 需要 vite，wps-wpp-ts-esbuild
 * 需要 esbuild），仓库的测试不应该依赖示例的 npm install。那些脚本是给人用的，
 * 用法见 examples/README.md。
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { API_PREFIX } from "../src/protocol.js"
import { parseArgs, run } from "../src/runner.js"
import { createBridgeMiddleware } from "../src/server.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLES_DIR = path.resolve(HERE, "../examples")
const PAGE_FIXTURE = path.join(HERE, "fixtures/page.mjs")
const CLIENT_WAIT_TIMEOUT_MS = 30_000
const BRIDGE_TIMEOUT_MS = "60000"

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number)
/** TS 示例要靠 Node 直接 import .ts（类型擦除）：Node 22.18+ / 23.6+ 默认支持。 */
const NODE_STRIPS_TYPES = nodeMajor > 23
  || (nodeMajor === 23 && nodeMinor >= 6)
  || (nodeMajor === 22 && nodeMinor >= 18)

/** 三个示例：与 examples/ 下的目录一一对应。 */
const EXAMPLES = [
  {
    id: "wps-writer-js",
    title: "WPS 文字 · 纯 JS",
    app: "wps",
    // 纯 JS 示例用普通 <script> 加载页面代码，顺序与 index.html 一致
    scripts: ["js/util.js", "js/hello.js", "js/host.js", "js/ribbon.js"],
    module: "",
    testFile: "./test/hello.test.js",
    reportTitle: "WPS 文字 · 纯 JS Hello World",
    button: "btnHello",
    readBack: "return Application.ActiveDocument.Content.Text",
    needsTs: false,
  },
  {
    id: "wps-et-ts-vite",
    title: "WPS 表格 · TS + Vite",
    app: "et",
    scripts: [],
    module: "src/main.ts",
    testFile: "./test/hello.test.ts",
    reportTitle: "WPS 表格 · TS + Vite Hello World",
    button: "btnHello",
    readBack: "return Application.ActiveWorkbook.ActiveSheet.Range(\"A1\").Value2",
    needsTs: true,
  },
  {
    id: "wps-wpp-ts-esbuild",
    title: "WPS 演示 · TS + esbuild",
    app: "wpp",
    scripts: [],
    module: "src/main.ts",
    testFile: "./test/hello.test.ts",
    reportTitle: "WPS 演示 · TS + esbuild Hello World",
    button: "btnHello",
    readBack: "return Application.ActivePresentation.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text",
    needsTs: true,
  },
]

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** 起一个只挂了桥中间件的 http 服务（示例的 dev server 就是这个骨架）。 */
async function startBridgeServer() {
  const bridge = createBridgeMiddleware({
    readyCheck: "typeof window.OnAction === 'function'",
    readyTimeoutMs: 15_000,
    // 测试不往项目目录里写端口文件
    portFile: false,
  })
  const server = createServer((request, response) => {
    bridge.handle(request, response, () => {
      response.statusCode = 404
      response.end("not found")
    })
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { bridge, server, port: server.address().port }
}

/** 等页面模拟器把客户端接上桥；页面提前退出就把它的输出抛出来，方便定位。 */
async function waitForPage(port, page, pageLog) {
  const deadline = Date.now() + CLIENT_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (page.exitCode !== null) {
      throw new Error(`页面模拟器退出了（code=${page.exitCode}）：\n${pageLog.join("")}`)
    }
    const status = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/status`)
      .then(response => response.json())
      .catch(() => null)
    if (status?.clients?.length > 0) return
    await delay(200)
  }
  throw new Error(`等不到页面接入桥（${CLIENT_WAIT_TIMEOUT_MS} ms）：\n${pageLog.join("")}`)
}

/**
 * 起一个示例的页面，跑完 body 再收拾干净。
 * @param {typeof EXAMPLES[number]} example
 * @param {(context: { port: number, root: string }) => Promise<void>} body
 */
async function withPage(example, body) {
  const root = path.join(EXAMPLES_DIR, example.id)
  const { bridge, server, port } = await startBridgeServer()

  const argv = [PAGE_FIXTURE, "--port", String(port), "--root", root, "--app", example.app]
  if (example.module) argv.push("--module", example.module)
  if (example.scripts.length > 0) argv.push("--scripts", example.scripts.join(","))

  const page = spawn(process.execPath, argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  const pageLog = []
  page.stdout.on("data", chunk => pageLog.push(String(chunk)))
  page.stderr.on("data", chunk => pageLog.push(String(chunk)))

  try {
    await waitForPage(port, page, pageLog)
    return await body({ port, root, pageLog })
  }
  finally {
    page.kill()
    bridge.dispose()
    await new Promise(resolve => server.close(resolve))
  }
}

/**
 * 在示例目录里跑一条桥命令，并把两条输出通道**分开**抓回来。
 *
 * 桥的约定是：stdout 只有被测页面的输出与命令返回值，桥自己的诊断走 stderr ——
 * 这里顺便帮这条约定把关（重定向 `> 报告.txt` 拿到的应该是干净的报告）。
 *
 * 两条要点：
 *   - run() 按 process.cwd() 解析文件路径（示例目录里的 ./test/hello.test.js），所以要切目录；
 *   - 桥既写 console 也直接写 process.stdout/stderr.write，所以拦 write 一处就够。
 */
async function runBridge(root, argv) {
  const out = []
  const err = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  process.stdout.write = chunk => {
    out.push(String(chunk))
    return true
  }
  process.stderr.write = chunk => {
    err.push(String(chunk))
    return true
  }

  const cwd = process.cwd()
  process.chdir(root)
  try {
    const code = await run(parseArgs(argv))
    const stdout = out.join("")
    const stderr = err.join("")
    return { code, stdout, stderr, text: `${stdout}${stderr}` }
  }
  finally {
    process.chdir(cwd)
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}

for (const example of EXAMPLES) {
  const skip = example.needsTs && !NODE_STRIPS_TYPES
    ? "需要 Node 22.18+ 才能直接执行示例里的 .ts"
    : false

  test(`${example.title}：经桥执行的测试模块全部通过`, { skip }, async () => {
    await withPage(example, async ({ port, root }) => {
      const result = await runBridge(root, [
        "run", example.testFile,
        "--expect-report",
        "--port", String(port),
        "--timeout", BRIDGE_TIMEOUT_MS,
      ])

      assert.equal(result.code, 0, `退出码应为 0，实际 ${result.code}：\n${result.text}`)
      // 页面的输出（每个用例 + 报告行）在 stdout，桥自己的判定在 stderr
      assert.ok(result.stdout.includes(`${example.reportTitle}: tests=`), `报告行应当在 stdout：\n${result.text}`)
      assert.match(result.stdout, /^ok   /m, "每条用例的日志也应回传到终端")
      assert.doesNotMatch(result.stdout, /\[wps-bridge\]/, "桥的诊断不该混进 stdout")
      assert.match(result.stderr, /报告：tests=\d+ passed=\d+ failed=0/, result.text)
    })
  })

  test(`${example.title}：click 触发 Ribbon 入口并把结果写进宿主`, { skip }, async () => {
    await withPage(example, async ({ port, root }) => {
      const clicked = await runBridge(root, [
        "click", example.button,
        "--port", String(port),
        "--timeout", BRIDGE_TIMEOUT_MS,
      ])
      assert.equal(clicked.code, 0, `退出码应为 0，实际 ${clicked.code}：\n${clicked.text}`)

      const read = await runBridge(root, [
        "eval", example.readBack,
        "--port", String(port),
        "--timeout", BRIDGE_TIMEOUT_MS,
      ])
      assert.equal(read.code, 0, read.text)
      // 命令的返回值是“用户要的数据”，也走 stdout
      assert.match(read.stdout, /Hello World/, `宿主里的内容应当被写入：\n${read.text}`)
    })
  })
}

test("status：能列出已接入的示例页面", async () => {
  await withPage(EXAMPLES[0], async ({ port, root }) => {
    const { code, stdout, text } = await runBridge(root, ["status", "--port", String(port)])
    assert.equal(code, 0, text)
    // 给人看的走 stderr，给脚本吃的 JSON 走 stdout
    assert.match(text, /已连接的页面：page-/, text)
    assert.match(stdout, /"clients":\[/, text)
    assert.match(stdout, /"state":"idle"/, text)
    assert.match(text, /排队中的命令：0/, text)
  })
})

test("报告里有失败项时退出码为 1", async () => {
  await withPage(EXAMPLES[0], async ({ port, root }) => {
    const { code, text, stderr } = await runBridge(root, [
      // 项目外的文件会被解析成 /@fs/<绝对路径> 再交给页面
      "run", "../../test/fixtures/failing.test.js",
      "--expect-report",
      "--port", String(port),
      "--timeout", BRIDGE_TIMEOUT_MS,
    ])

    assert.equal(code, 1, `有 failed 时退出码应为 1，实际 ${code}：\n${text}`)
    assert.match(stderr, /报告：tests=2 passed=1 failed=1/, text)
  })
})

test("run 默认复用页面里的模块实例，--fresh 才会重新执行", async () => {
  await withPage(EXAMPLES[0], async ({ port, root }) => {
    const runFixture = () => runBridge(root, [
      "run", "../../test/fixtures/exec-counter.test.js",
      "--port", String(port),
      "--timeout", BRIDGE_TIMEOUT_MS,
    ])

    // 第一次：模块被求值
    assert.match((await runFixture()).stdout, /"executions":1/)
    // 第二次：还是页面里的同一个模块实例（这正是 call/run 能拿到运行期状态的原因）
    assert.match((await runFixture()).stdout, /"executions":1/)

    // --fresh：带 mtime 参数重新 import，dev server 重新编译、页面重新求值
    const fresh = await runBridge(root, [
      "run", "../../test/fixtures/exec-counter.test.js",
      "--fresh",
      "--port", String(port),
      "--timeout", BRIDGE_TIMEOUT_MS,
    ])
    assert.match(fresh.stdout, /"executions":2/, fresh.text)
  })
})
