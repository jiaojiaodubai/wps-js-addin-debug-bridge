/**
 * 桥的终端侧：把命令交给页面执行，把页面日志流式打印出来，并按结果设置退出码。
 *
 * 为什么不是“直接连 WPS”：WPS 没有对外的 JS 求值通道 ——
 *   - 自定义 Ribbon 按钮不在 COM 的 `Application.CommandBars` 里，`Application.Run` 只认宏；
 *   - CEF 远程调试端口由宿主自己拉起（本机实测加载项页面所在进程开不出来）。
 * 所以走“我们自己下发的页面”：开发模式下页面由 dev server 提供，注入的客户端
 * 代我们执行触发与调用，本文件负责下发、重发与判定。
 *
 * 两条输出通道是分开的（很重要）：
 *   - **stdout：只有被测页面的输出**（`> 报告.txt` 拿到的就是干净的报告）；
 *   - **stderr：桥自己的诊断**（`[wps-bridge] ...`）。
 *
 * 用法（也可用 bin/cli.js 包装的 `wps-bridge` 命令）：
 *   wps-bridge status
 *   wps-bridge click btnRefresh
 *   wps-bridge click btnRunTests --expect-report
 *   wps-bridge run ./test/perf.ts --expect-report
 *   wps-bridge eval 'return Application.Version'
 */

import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import { createLogger } from "./logger.js"
import { createReporter } from "./reporters.js"
import {
  API_PREFIX,
  DEFAULT_PORT_FILE,
  DEFAULT_REPORT_PATTERN,
  POLL_TIMEOUT_MS,
  PROTOCOL_VERSION,
  describeCommand,
} from "./protocol.js"

const SERVER_READY_TIMEOUT_MS = 90_000
const CLIENT_WAIT_TIMEOUT_MS = 120_000
const EXPLICIT_TARGET_GRACE_MS = 5_000
const ACK_TIMEOUT_MS = 20_000
const SUBMIT_ATTEMPTS = 3

/** dev server 默认端口（vite 的默认值；官方 wpsjs 模板用 3889）。 */
export const DEFAULT_PORT = 5173

/** 退出码（README 里也是这套）。 */
export const EXIT = {
  ok: 0,
  failed: 1,
  noClient: 2,
  timeout: 3,
}

/** 由 --start 拉起的 dev server，退出时要一起收拾。 */
const activeChildren = new Set()

/**
 * 由 --launch 拉起的 WPS launcher 进程：退出时要把它收回去（谁启动谁负责，本来开着的实例不碰）。
 *
 * 子进程退出后**不**从集合里删：launcher 自己退出说明启动请求并入了已经在跑的实例
 * （WPS 是单实例），收尾时正是靠这个信号判断“这个实例不是我们拉起的”。
 */
const launchedWps = new Set()

/** 探针文档所在目录（`--launch` 没给 `--doc` 时用）。 */
export const PROBE_DOC_DIR = path.join(os.tmpdir(), "wps-bridge")

/**
 * 探针文档：没有 `--doc` 时用它把加载项页面“唤起来”。
 *
 * 页面只在文档打开时才创建（停在首页不算），所以 --launch 必须带上一个文档：
 *   - 必须是**真实存在**的文件：传一个不存在的路径 WPS 不会打开任何文档（本机实测）；
 *   - 必须是**只可能由 WPS 文字打开**的类型：`.txt` 会弹“请选择打开文件的方式”
 *     （文字/表格都可能），那个弹窗是模态的，页面就永远等不到了。`.rtf` 没有歧义。
 * 文档留在系统临时目录不删：WPS 会把它记进最近文档，删掉反而让下次启动拿到一个打不开的路径。
 * @returns {string} 探针文档路径
 */
export function ensureProbeDocument(dir = PROBE_DOC_DIR) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "probe.rtf")
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0 wps-js-addin-debug-bridge 探针文档，可以随时删除。}\n", "utf8")
  }
  return file
}

/** 解析命令行参数（纯函数，便于单测）。 */
export function parseArgs(argv) {
  const options = {
    command: "status",
    positionals: [],
    port: 0,
    timeout: 900_000,
    launch: false,
    exe: process.env.WPS_EXE ?? "",
    doc: "",
    start: "npm run dev",
    keepServer: false,
    keepWps: false,
    expectReport: false,
    reportPattern: DEFAULT_REPORT_PATTERN,
    reporter: "regex",
    out: "",
    token: "",
    target: "newest",
    quiet: false,
    fresh: false,
    useHook: true,
    argvArgs: [],
    exportName: "",
    followMs: 0,
    help: false,
  }

  const takesValue = new Set([
    "--port", "--timeout", "--exe", "--doc", "--start", "--args", "--arg",
    "--export", "--follow", "--report-pattern", "--reporter", "--out", "--token", "--target",
  ])
  const rest = [...argv]
  while (rest.length > 0) {
    const current = rest.shift()
    if (takesValue.has(current)) {
      const value = rest.shift()
      if (value === undefined) throw new Error(`${current} 需要一个值`)
      if (current === "--port") options.port = Number(value)
      else if (current === "--timeout") options.timeout = Number(value)
      else if (current === "--exe") options.exe = value
      else if (current === "--doc") options.doc = value
      else if (current === "--start") options.start = value
      else if (current === "--args") options.args = value
      else if (current === "--arg") options.argvArgs.push(value)
      else if (current === "--export") options.exportName = value
      else if (current === "--follow") options.followMs = Number(value)
      else if (current === "--reporter") options.reporter = value
      else if (current === "--out") options.out = value
      else if (current === "--token") options.token = value
      else if (current === "--target") options.target = value
      else options.reportPattern = value
    }
    else if (current === "--launch") options.launch = true
    else if (current === "--keep-server") options.keepServer = true
    else if (current === "--keep-wps") options.keepWps = true
    else if (current === "--expect-report") options.expectReport = true
    else if (current === "--no-hook") options.useHook = false
    else if (current === "--fresh") options.fresh = true
    else if (current === "--quiet") options.quiet = true
    else if (current === "--help" || current === "-h") options.help = true
    else if (current.startsWith("--")) throw new Error(`未知选项：${current}`)
    else options.positionals.push(current)
  }

  if (options.positionals.length > 0) options.command = options.positionals.shift()
  return options
}

/** 单个参数：能当 JSON 解析就按 JSON，否则当字符串（Windows cmd 会吞掉引号，故常用）。 */
function parseArgValue(raw) {
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

/** `--args` 的 JSON 数组；解析失败时给出可操作的提示。 */
function parseArgsOption(raw) {
  try {
    return JSON.parse(raw)
  }
  catch (error) {
    throw new Error(`--args 不是合法 JSON：${raw}（${error.message}）。Windows 下 .cmd 包装会吞掉内层引号，可改用 --arg 逐个传参`)
  }
}

/** call / run 的调用参数。 */
function collectArgs(options) {
  if (options.argvArgs?.length) return options.argvArgs.map(parseArgValue)
  if (options.args) return parseArgsOption(options.args)
  return []
}

/** 绝对路径 → dev server 能访问的 URL：项目内用根路径，项目外用 `/@fs/<绝对路径>`。 */
export function toModuleUrl(absolutePath) {
  const root = process.cwd()
  const relative = path.relative(root, absolutePath)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `/${relative.split(path.sep).join("/")}`
  }
  return `/@fs/${absolutePath.split(path.sep).join("/")}`
}

/** 解析 `run` 的文件参数：既给出磁盘路径（用于 cache-busting），也给出 URL。 */
export function resolveModule(input) {
  const file = path.resolve(process.cwd(), input)
  if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)
  return { file, url: toModuleUrl(file) }
}

/** 把命令行里的文件路径解析成 dev server 能访问的 URL（保留：单测与外部调用在用）。 */
export function resolveModuleFile(input) {
  return resolveModule(input).url
}

/**
 * `--fresh` 的 cache-busting 参数。
 *
 * 默认不刷新是有意的：`call`/`run` 拿到的是页面里**同一个模块实例**，
 * 这样才能访问加载项的运行期状态（缓存、单例）。但改了文件之后要跑新代码时，
 * 浏览器与 dev server 都可能还拿着旧的，于是给个显式的开关。
 * 文件在的话用 mtime：同一版代码仍然共享实例，改了才换新的。
 */
function freshTokenFor(moduleUrl) {
  const candidate = path.resolve(process.cwd(), moduleUrl.replace(/^\/@fs\//, "").replace(/^\//, ""))
  try {
    return String(fs.statSync(candidate).mtimeMs)
  }
  catch {
    return String(Date.now())
  }
}

function withFresh(moduleUrl, fresh) {
  if (!fresh) return moduleUrl
  return `${moduleUrl}${moduleUrl.includes("?") ? "&" : "?"}t=${freshTokenFor(moduleUrl)}`
}

/** 把解析结果变成桥命令（纯函数，便于单测）。 */
export function buildCommand(options) {
  const [first, second] = options.positionals
  switch (options.command) {
    case "click": {
      if (!first) throw new Error("click 需要控件 Id，例如：click btnRefresh")
      return { kind: "click", controlId: first }
    }
    case "call": {
      if (!first || !second) throw new Error("call 需要模块路径与函数名，例如：call /src/modules/refresh.ts refreshAll")
      return { kind: "call", module: withFresh(first, options.fresh), fn: second, args: collectArgs(options) }
    }
    case "run": {
      if (!first) throw new Error("run 需要文件路径，例如：run ./test/perf.ts")
      return {
        kind: "run",
        file: withFresh(resolveModule(first).url, options.fresh),
        exportName: options.exportName || undefined,
        args: collectArgs(options),
      }
    }
    case "eval": {
      if (!first) throw new Error("eval 需要一段 JS 代码，例如：eval 'return Application.Version'")
      return { kind: "eval", code: options.positionals.join(" ") }
    }
    default:
      throw new Error(`未知命令：${options.command}`)
  }
}

export const USAGE = `wps-bridge —— WPS JS 加载项开发期调试桥

用法：
  wps-bridge status                     查看桥与页面连接状态
  wps-bridge click <控件Id> [选项]       触发页面入口（等价于点击 Ribbon 按钮）
  wps-bridge call <模块> <函数> [选项]   调用运行中的页面模块（与页面同一模块实例）
  wps-bridge run <文件> [选项]           在页面里执行一个模块文件（支持 .ts，由 dev server 编译）
  wps-bridge eval '<代码>' [选项]        在页面里执行代码，可 return 一个值

选项：
  --port <n>            dev server 端口（默认自动：读 .wps-bridge.json，读不到用 ${DEFAULT_PORT}）
  --target <目标>       命令发给哪个页面：newest（默认）或 status 里列的页面 id
  --export <名字>        run 时指定要调用的导出（默认 default / main）
  --fresh               让 dev server 重新编译并重新执行该模块（默认复用页面里的同一实例）
  --expect-report       等到页面输出报告行为止，并用其中的 failed= 决定退出码
  --report-pattern <re> 报告行正则（默认 ${DEFAULT_REPORT_PATTERN}）
  --reporter <名字>     regex（默认）/ json / 自定义模块路径（配 --out 写文件）
  --out <文件>          reporter 的输出文件（默认 stdout）
  --timeout <ms>        单条命令超时（默认 900000）
  --follow <ms>         命令返回后继续收集日志的时长（默认 0；适合 click 这类
                        立即返回、后台继续干活的入口）
  --arg <值>            call / run 的单个参数，可重复；能当 JSON 解析就按 JSON 传
  --args <json>         call / run 的参数数组（JSON）
  --token <值>          桥要求 token 时用（一般会从 .wps-bridge.json 自动读到）
  --launch              没有页面接入时自动启动 WPS（自动打开文档唤起页面；跑完自动关掉）
  --doc <path>          配合 --launch 打开的文档（不给就用临时目录里的探针文档）
  --exe <path>          指定 wps.exe（也可用环境变量 WPS_EXE）
  --start <命令>        本地没有 dev server 时用该命令启动（默认 "npm run dev"）
  --keep-server         本次启动的 dev server 保留不关
  --keep-wps            保留 --launch 拉起的 WPS（默认跑完关掉；本来开着的实例不碰）
  --no-hook             不启用页面钩子（恢复加载项自身的模态提示）
  --quiet               只输出错误（诊断信息都在 stderr）

输出：页面输出走 stdout，桥自己的诊断走 stderr（方便重定向与 CI 抓报告）。

退出码：${EXIT.ok} 成功；${EXIT.failed} 命令失败或报告里有 failed；${EXIT.noClient} 没有页面接入；${EXIT.timeout} 超时。
`

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function apiUrl(endpoint, action) {
  return `http://127.0.0.1:${endpoint.port}${API_PREFIX}/${action}`
}

function bridgeHeaders(endpoint) {
  const headers = { "Content-Type": "application/json" }
  if (endpoint.token) headers["x-wps-bridge-token"] = endpoint.token
  return headers
}

async function requestJson(url, init, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return await response.json()
  }
  finally {
    clearTimeout(timer)
  }
}

async function postJson(url, body, endpoint) {
  return requestJson(url, {
    method: "POST",
    headers: bridgeHeaders(endpoint),
    body: JSON.stringify(body ?? {}),
  })
}

async function getJson(url, endpoint, timeoutMs = 5_000) {
  return requestJson(url, { headers: bridgeHeaders(endpoint) }, timeoutMs)
}

async function isBridgeUp(endpoint, timeoutMs = 2_000) {
  try {
    await getJson(apiUrl(endpoint, "status"), endpoint, timeoutMs)
    return true
  }
  catch {
    return false
  }
}

/**
 * 找 dev server：--port 优先，其次是项目里的 .wps-bridge.json（dev server 自己写的，
 * 里面还有 token），最后才是默认端口。省得 5173/3889 两边手工对齐。
 */
export function resolveEndpoint(options, logger = createLogger({ quiet: true })) {
  if (options.port) return { port: options.port, token: options.token, source: "--port" }

  const found = readPortFile(process.cwd())
  if (found && Date.now() - Date.parse(found.startedAt ?? 0) < 7 * 24 * 3600 * 1000) {
    logger.info(`端口来自 ${found.file}（pid ${found.pid}）`)
    return { port: found.port, token: options.token || found.token || "", source: path.basename(found.file) }
  }

  return { port: DEFAULT_PORT, token: options.token, source: "默认值" }
}

/** 从 cwd 一路往上找端口文件（和 vite 找 workspace root 是一个思路）。 */
function readPortFile(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    const file = path.join(dir, DEFAULT_PORT_FILE)
    if (fs.existsSync(file)) {
      try {
        const info = JSON.parse(fs.readFileSync(file, "utf8"))
        if (Number(info?.port) > 0) return { ...info, file }
      }
      catch {
        // 文件坏了就当没有
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 本地没有 dev server 时按 --start 启动一个（结束时若由我们启动则关掉）。 */
async function ensureServer(options, endpoint, logger) {
  if (await isBridgeUp(endpoint)) return null
  if (!options.start) throw new Error(`端口 ${endpoint.port} 上没有桥，且未指定 --start 启动命令`)

  logger.info(`未发现 ${endpoint.port} 上的 dev server，正在启动：${options.start}`)
  const child = spawn(options.start, {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX 下自成进程组，退出时才能把 shell 拉起的孙进程一起收拾
    detached: process.platform !== "win32",
  })
  activeChildren.add(child)
  child.stdout.on("data", chunk => logger.raw(`[dev] ${chunk}`))
  child.stderr.on("data", chunk => logger.raw(`[dev] ${chunk}`))

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(500)
    if (await isBridgeUp(endpoint)) return child
    // --port 没指定时，dev server 可能自己写在别的端口上（端口文件就是干这个的）
    if (!options.port) {
      const discovered = resolveEndpoint({ ...options, port: 0 }, logger)
      if (discovered.port !== endpoint.port && await isBridgeUp(discovered)) return child
    }
  }
  stopServer(child)
  throw new Error("dev server 启动超时（桥未挂载？确认 dev server 配置里用了 wpsDebugBridge 插件或 createBridgeMiddleware）")
}

/** 连孙进程一起收拾：shell: true 起的其实是 shell，只杀直接子进程会留下孤儿。 */
export function stopServer(child) {
  if (!child) return
  activeChildren.delete(child)
  if (child.exitCode !== null) return
  try {
    child.kill()
  }
  catch {
    // 忽略
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    }
    catch {
      // 进程可能已经退出
    }
  }
  else {
    try {
      process.kill(-child.pid, "SIGTERM")
    }
    catch {
      // 没有独立进程组（比如别处创建的 child）就算了
    }
  }
}

export function stopAllServers() {
  for (const child of [...activeChildren]) stopServer(child)
}

/** 强杀后等进程退出的时间。 */
const WPS_STOP_GRACE_MS = 5_000

/** 页面退出后的等待时间：Quit 已经送到，留一拍让它真的把进程收掉。 */
const QUIT_SETTLE_MS = 2_000

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, milliseconds)
    child.once("exit", onExit)
  })
}

/**
 * 关掉由 --launch 拉起的 WPS launcher 进程（连它的子进程一起）。
 *
 * 这里直接强杀，不做“温和关闭”：实测 `taskkill`（不带 `/F`，相当于给顶层窗口发 WM_CLOSE）
 * 会停在保存提示上 —— 提示是模态的，自动化里没人能点，进程就一直挂着。
 * 温和的那一步由页面侧的 `Application.Quit(0)` 负责（见 quitViaPage）；
 * 走到这里时实例只剩 launcher 留下的窗口壳。
 * @returns {Promise<boolean>} 进程是否已退出
 */
export async function stopWps(child, { graceMs = WPS_STOP_GRACE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    }
    else {
      // 拉起的进程自成进程组：杀整组，别留下它自己拉起的子进程
      process.kill(-child.pid, "SIGKILL")
    }
  }
  catch {
    // 进程可能刚好自己退出了；也可能没有独立进程组，下面兜一下
    try {
      child.kill("SIGKILL")
    }
    catch {
      // 忽略
    }
  }
  return waitForExit(child, graceMs)
}

/**
 * 让页面自己 `Application.Quit(0)`：精确关掉“服务这个页面的那个实例”。
 *
 * 为什么不用进程级关闭代替：`--launch` 拉起的实例里，窗口由 launcher 进程持有，
 * 进程级要么发 WM_CLOSE（撞上保存提示就永远停着），要么强杀（丢数据）。
 * 页面里的 `Quit(0)` 是“不保存、不提示”，而且只影响页面所在的那个实例。
 * 命令送到就行 —— Quit 之后页面自己就没了，等它的结果只会白等。
 * @returns {Promise<boolean>} 页面是否已经退出
 */
async function quitViaPage(endpoint, logger, target = "newest") {
  const status = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
  const clientId = pickClient(status, target)
  if (!clientId) return false

  const payload = await postJson(apiUrl(endpoint, "submit"), {
    kind: "eval",
    // 只是把 Quit 排进队列，别让命令的返回把 Quit 挡住
    code: 'setTimeout(() => Application.Quit(0), 0); return "quit"',
    id: `eval-${Date.now()}-quit`,
    clientId,
    useHook: false,
  }, endpoint).catch(() => null)
  if (!payload || payload.ok === false) return false
  logger.info(`已请页面 ${clientId} 退出 WPS（Application.Quit(0)：不保存、不弹提示）`)

  await delay(QUIT_SETTLE_MS)
  const after = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
  const client = (after?.clients ?? []).find(item => item.id === clientId)
  return !client || client.state === "offline"
}

/** Ctrl-C 时把拉起的 WPS 也收拾掉（这时不需要温和）。 */
export function stopAllWps() {
  for (const child of [...launchedWps]) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      else child.kill("SIGKILL")
    }
    catch {
      // 忽略
    }
  }
}

/** 跑完把 --launch 拉起的 WPS 关掉：测试要闭环，机器回到开跑前的样子。 */
async function stopLaunchedWps(options, logger, endpoint) {
  for (const child of [...launchedWps]) {
    if (options.keepWps) {
      logger.info(`本次启动的 WPS 保留不关（--keep-wps，pid ${child.pid}）`)
      continue
    }
    // 启动请求并入了已经在跑的实例：那个实例不是我们拉起的，不关它
    if (child.exitCode !== null || child.signalCode !== null) {
      logger.info("启动请求并入了已在运行的 WPS 实例：本次不关闭它（--launch 只关自己拉起的实例）")
      continue
    }
    logger.info(`正在关闭本次启动的 WPS（pid ${child.pid}；--keep-wps 可保留）`)
    const quit = endpoint ? await quitViaPage(endpoint, logger, options.target) : false
    if (!quit) logger.warn("页面没有确认退出（没有页面接入，或主线程没响应）：接下来的进程级关闭会直接结束实例，未保存内容会丢")
    const stopped = await stopWps(child)
    if (stopped) logger.info(`已关闭 WPS（pid ${child.pid}）`)
    else logger.warn(`没能关掉 WPS（pid ${child.pid}）`)
  }
}

/** 按注册表/安装目录找 wps.exe（只有 --launch 时才需要）。 */
export function resolveWpsExe(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath

  for (const hive of ["HKEY_CLASSES_ROOT", "HKEY_CURRENT_USER\\SOFTWARE\\Classes"]) {
    try {
      const output = execFileSync("reg", ["query", `${hive}\\KWPS.Document.12\\shell\\new\\command`, "/ve"], { encoding: "utf8" })
      const matched = /"([^"]*wps\.exe)"/i.exec(output)
      if (matched && fs.existsSync(matched[1])) return matched[1]
    }
    catch {
      // 换下一种方式
    }
  }

  const root = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Kingsoft", "WPS Office")
  if (fs.existsSync(root)) {
    const candidates = fs.readdirSync(root)
      .map(name => path.join(root, name, "office6", "wps.exe"))
      .filter(candidate => fs.existsSync(candidate))
      .sort()
    if (candidates.length > 0) return candidates.at(-1)
  }
  throw new Error("找不到 wps.exe，请用 --exe 指定路径或设置环境变量 WPS_EXE")
}

function launchWps(exePath, documentPath, logger) {
  // 页面只在文档打开时才创建：没给 --doc 就用探针文档，否则启动完还是等不到页面
  const document = documentPath || ensureProbeDocument()
  if (!documentPath) logger.info(`未指定 --doc：用探针文档唤起加载项页面（${document}）`)
  else if (!fs.existsSync(documentPath)) logger.warn(`--doc 指向的文件不存在：${documentPath} —— WPS 不会真的打开它，页面可能不会出现`)

  const args = ["/prometheus", "/wps", document]
  logger.info(`启动 WPS：${exePath} ${document}`)
  const child = spawn(exePath, args, { detached: true, stdio: "ignore", windowsHide: true })
  child.unref()
  // WPS 单实例：与已打开的实例合并时这个进程会自己退出 —— 收尾时就靠这个信号
  // 判断“实例不是我们拉起的”，所以这里不把它从集合里删掉（见 stopLaunchedWps）
  launchedWps.add(child)
  return child
}

/** 从状态里挑一个页面：优先最新且“信标正常、主线程在推进”的（失联/无响应的会拖住命令）。 */
export function pickClient(status, target) {
  const clients = status?.clients ?? []
  if (clients.length === 0) return null
  if (target && target !== "newest") {
    return clients.some(client => client.id === target) ? target : null
  }
  const responsive = clients.filter(client => client.state !== "offline" && client.state !== "stalled")
  const reachable = clients.filter(client => client.state !== "offline")
  return (responsive.at(-1) ?? reachable.at(-1) ?? clients.at(-1)).id
}

/**
 * 等页面时用的挑选：只剩失联页面就等于“没有页面”。
 *
 * 收尾关掉 WPS 之后，旧的页面登记还要过一会儿才被回收；紧接着跑下一轮时，
 * 它看起来就是个“页面”—— 命令送进去只会石沉大海，--launch 也不会去启动新实例。
 * 指定了 --target 时不这么算：用户指定了哪个页面，失败原因就直接告诉他。
 */
export function pickUsableClient(status, target) {
  const clientId = pickClient(status, target)
  if (!clientId || (target && target !== "newest")) return clientId
  const client = (status?.clients ?? []).find(item => item.id === clientId)
  return client?.state === "offline" ? null : clientId
}

async function waitForClient(endpoint, options, logger) {
  const startedAt = Date.now()
  const deadline = startedAt + CLIENT_WAIT_TIMEOUT_MS
  let launched = false
  let toldOffline = false

  while (Date.now() < deadline) {
    const status = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
    const clientId = pickUsableClient(status, options.target)
    if (clientId) {
      const client = status.clients.find(item => item.id === clientId)
      if (client?.state === "stalled") {
        logger.warn(`选中的页面 ${clientId} 主线程 ${client.mainStallMs} ms 没有响应（宿主弹窗或长同步任务都可能），命令可能延迟执行`)
      }
      else if (client?.state === "offline") {
        logger.warn(`选中的页面 ${clientId} 信标停了 ${client.beaconAgeMs} ms（页面可能已关闭或崩溃），命令可能送不进去`)
      }
      return clientId
    }
    if (!toldOffline && (status?.clients ?? []).some(client => client.state === "offline")) {
      const stale = status.clients.filter(client => client.state === "offline").map(client => client.id).join(", ")
      logger.info(`已连接的页面都失联了（${stale}）：等一个新页面接入（页面登记会过期回收）`)
      toldOffline = true
    }
    if (options.target !== "newest" && status && Date.now() - startedAt > EXPLICIT_TARGET_GRACE_MS) {
      const ids = (status.clients ?? []).map(client => client.id).join(", ") || "（无）"
      throw new Error(`指定的页面 ${options.target} 不在已连接的页面里。当前连接：${ids}`)
    }
    if (!launched && options.launch && Date.now() - startedAt > 5_000) {
      launchWps(resolveWpsExe(options.exe), options.doc, logger)
      launched = true
      logger.info("等待页面接入桥...")
    }
    await delay(1_000)
  }
  return null
}

/** 事件游标：保证每条事件只分发一次（事件日志是重放的，用 seq 推进）。 */
function createEventPump(endpoint, collect) {
  let seq = 0
  let warnedGap = false

  return {
    get cursor() {
      return seq
    },
    async pump(deadline, stop) {
      while (Date.now() < deadline && !stop()) {
        let payload
        try {
          payload = await getJson(apiUrl(endpoint, `events?since=${seq}`), endpoint, POLL_TIMEOUT_MS + 10_000)
        }
        catch {
          // dev server 可能因配置改动重启，退避后重试而不是放弃整轮。
          await delay(2_000)
          continue
        }
        // 事件太多被环形缓冲丢过：明确说一声，别让日志看起来“凭空少了一段”
        if (!warnedGap && Number(payload.droppedBefore ?? 0) > seq) {
          warnedGap = true
          collect({ type: "gap", droppedBefore: payload.droppedBefore })
        }
        for (const event of payload.events ?? []) {
          seq = Math.max(seq, event.seq)
          collect(event)
        }
        if ((payload.events ?? []).length === 0 && payload.seq <= seq) return
      }
    },
    resync() {
      seq = 0
      warnedGap = false
    },
  }
}

/**
 * 下发命令；页面没在窗口期内确认收到（例如刚刷新过一次）就重发。
 *
 * 重发用**同一个 id**：页面侧按 id 去重，所以重复送达不会重复执行 ——
 * 这比“换个新 id 再发一遍”安全得多（那会导致文档被写两遍）。
 */
async function submitWithAck(endpoint, command, pump, state, deadline, options, logger) {
  const id = `${command.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  state.commandId = id

  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt += 1) {
    state.started = false
    // 目标页面可能刚刷新过（id 变了），每次重试都重新挑一个
    const status = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
    const clientId = pickClient(status, options.target)
    state.clientId = clientId

    const payload = await postJson(apiUrl(endpoint, "submit"), { ...command, id, clientId }, endpoint)
    if (payload?.ok === false) throw new Error(payload.error)

    logger.info(`已下发命令 ${id}（第 ${attempt} 次，目标 ${clientId ?? "任意页面"}）`)
    await pump.pump(Math.min(deadline, Date.now() + ACK_TIMEOUT_MS), () => state.started)
    if (state.started) return id
    logger.info("页面未确认收到命令，重新下发（同一 id，页面侧会去重）")
  }
  throw new Error(
    "命令未能送达页面。若 WPS 里弹出了对话框（模态弹窗会冻结页面），请先关掉它；"
    + "必要时重启 WPS，让加载项页面重新接入桥。",
  )
}

function stateLabel(client) {
  if (client.state === "offline") return `失联：信标停了 ${client.beaconAgeMs} ms（页面已关闭或崩溃）`
  if (client.state === "stalled") {
    const doing = client.busyCommandId ? `命令 ${client.busyCommandId} 执行中` : "当前没有命令在执行"
    return `主线程无响应：${client.mainStallMs} ms 没有推进（${doing}；宿主弹窗或长同步任务都可能）`
  }
  if (client.state === "busy") return `执行中：${client.busyCommandId}（已 ${client.busyMs} ms）`
  return "空闲"
}

async function printStatus(endpoint, logger, stdout) {
  const status = await getJson(apiUrl(endpoint, "status"), endpoint)
  logger.info(`桥：http://127.0.0.1:${endpoint.port}${API_PREFIX}（端口来源：${endpoint.source}，协议 ${status.protocol ?? "?"}）`)

  if ((status.clients ?? []).length === 0) {
    logger.info("已连接的页面：（无）")
    logger.info("提示：确认加载项页面由 dev server 提供且已重新加载（重启宿主应用，或用 --launch 启动 WPS）。")
  }
  else {
    logger.info(`已连接的页面：${status.clients.map(client => client.id).join(", ")}`)
    for (const client of status.clients) {
      logger.info(`  ${client.id}：${stateLabel(client)}；信标 ${client.beaconMode || "未知"}（${client.beaconAgeMs} ms 前），${client.idleMs} ms 前说过话`)
    }
  }
  logger.info(`排队中的命令：${status.queuedCommands}；事件序号：${status.eventSeq}`)
  if (status.protocol && status.protocol !== PROTOCOL_VERSION) {
    logger.warn(`桥的协议是 ${status.protocol}，终端是 ${PROTOCOL_VERSION}：请更新其中一边`)
  }
  // status 的正文走 stdout，方便脚本直接吃
  stdout.write(`${JSON.stringify(status)}\n`)
}

/** 主流程：返回退出码。 */
export async function run(options, { stdout = process.stdout, logger = createLogger({ quiet: options.quiet }) } = {}) {
  if (options.help) {
    stdout.write(USAGE)
    return EXIT.ok
  }

  // dev server 起来（或我们刚把它拉起来）之后端口文件才是最新的，所以这里再解析一次
  const endpoint = resolveEndpoint(options, logger)
  const server = await ensureServer(options, endpoint, logger)
  Object.assign(endpoint, resolveEndpoint(options, logger))
  if (endpoint.source === DEFAULT_PORT_FILE) {
    logger.info(`端口取自 ${DEFAULT_PORT_FILE}：${endpoint.port}`)
  }
  try {
    if (options.command === "status") {
      await printStatus(endpoint, logger, stdout)
      return EXIT.ok
    }
    const command = buildCommand(options)
    command.useHook = options.useHook
    const reporter = await createReporter({
      kind: options.reporter,
      pattern: options.reportPattern,
      cwd: process.cwd(),
    })

    const client = await waitForClient(endpoint, options, logger)
    if (!client) {
      const status = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
      const stale = (status?.clients ?? []).filter(item => item.state === "offline")
      if (stale.length > 0) {
        // 失联的页面会在登记表里留到过期为止：说清楚，免得看起来像“桥没接上”
        logger.error(`只看得到失联的页面：${stale.map(item => `${item.id}（信标停了 ${item.beaconAgeMs} ms）`).join("、")}`)
      }
      logger.error("没有等到页面接入桥。请确认：")
      logger.error("  1) dev server 正在运行，且配置里启用了 wpsDebugBridge 插件或 createBridgeMiddleware；")
      logger.error("  2) 宿主应用已重新加载开发版加载项（重启，或用 --launch 自动启动）。")
      return EXIT.noClient
    }
    logger.info(`页面已连接：${client}；命令：${describeCommand(command)}`)

    await postJson(apiUrl(endpoint, "reset"), {}, endpoint)
    const state = { commandId: null, clientId: null, started: false, result: null, page: null, mismatch: false }
    const startedAt = Date.now()

    const collect = (event) => {
      if (event.type === "started" && event.id === state.commandId) {
        state.started = true
      }
      else if (event.type === "log") {
        stdout.write(`${event.text}\n`) // 页面输出 → stdout（桥自己的话走 stderr）
        reporter.onLog(event)
      }
      else if (event.type === "hello") {
        state.page = { url: event.url, title: event.title }
        if (event.protocolMismatch) state.mismatch = true
      }
      else if (event.type === "gap") {
        logger.warn(`事件日志有断层（早于 #${event.droppedBefore} 的已被丢弃），日志可能不完整`)
      }
      else if (event.type === "result" && event.id === state.commandId) {
        state.result = event
      }
    }

    const pump = createEventPump(endpoint, collect)
    const commandFailed = () => state.result !== null && !state.result.ok
    const finished = () => options.expectReport
      ? reporter.report !== null || commandFailed()
      : state.result !== null
    const deadline = Date.now() + options.timeout

    await submitWithAck(endpoint, command, pump, state, deadline, options, logger)
    while (!finished() && !state.mismatch && Date.now() < deadline) {
      await pump.pump(deadline, finished)
    }

    if (state.mismatch) {
      logger.error(`加载项页面用的是旧版桥客户端（当前协议 ${PROTOCOL_VERSION}）。`)
      logger.error("在 WPS 里重新加载一次加载项（或重启 WPS）即可 —— 页面重新拉取 client.js 后就对上了。")
      return EXIT.noClient
    }

    if (commandFailed()) {
      // 命令自己失败时立即结束：即使开了 --expect-report 也不要干等到超时。
      // stack 里已经带了错误消息本身，避免重复打印。
      logger.error(`命令失败：${state.result.stack ?? state.result.error}`)
      return EXIT.failed
    }

    if (!finished()) {
      await explainTimeout(endpoint, state, options, logger)
      return EXIT.timeout
    }

    if (options.followMs > 0) {
      // click 这类入口是 fire-and-forget：命令已返回，但页面还在后台干活，
      // 多收一段时间的日志，避免漏掉它们的输出。
      const drainDeadline = Date.now() + options.followMs
      while (Date.now() < drainDeadline) {
        await pump.pump(drainDeadline, () => false)
        if (Date.now() < drainDeadline) await delay(250)
      }
    }

    if (state.result?.ok && state.result.value !== undefined && state.result.value !== "") {
      // 命令的返回值是“用户要的数据”，不是桥的碎碎念，所以也走 stdout
      stdout.write(`${state.result.value}\n`)
    }

    const report = reporter.report
    if (report) logger.info(`报告：tests=${report.total} passed=${report.passed} failed=${report.failed}`)
    else logger.info("本次命令没有产生报告（未使用 --expect-report 时属正常）。")

    const exitCode = report && report.failed > 0 ? EXIT.failed : EXIT.ok
    await reporter.finish({
      exitCode,
      command: { kind: command.kind, summary: describeCommand(command) },
      client,
      durationMs: Date.now() - startedAt,
      report,
      result: state.result,
      page: state.page,
      outFile: options.out,
      stdout,
      logger,
    })
    return exitCode
  }
  finally {
    // 先收 WPS 再收 dev server：页面用 Quit 退出时要经过桥的 API 确认
    await stopLaunchedWps(options, logger, endpoint)
    if (server && !options.keepServer) {
      stopServer(server)
      logger.info("已关闭本次启动的 dev server")
    }
  }
}

/** 超时是这套东西最常见的故障，原因说清楚一点。 */
async function explainTimeout(endpoint, state, options, logger) {
  const status = await getJson(apiUrl(endpoint, "status"), endpoint).catch(() => null)
  const client = status?.clients?.find(item => item.id === (state.clientId ?? pickClient(status, options.target)))

  if (client?.state === "offline") {
    logger.error(`命令超时：页面 ${client.id} 的信标停了 ${client.beaconAgeMs} ms —— 页面多半已关闭或崩溃，不是弹窗。`)
  }
  else if (client?.state === "stalled") {
    logger.error(`命令超时：页面 ${client.id} 还在（信标正常），但主线程已 ${client.mainStallMs} ms 没有推进。`)
    logger.error("先去 WPS 里看一眼有没有弹窗；没有的话，就是这条命令卡在自己的同步宿主调用上了。")
  }
  else if (client?.state === "busy") {
    logger.error(`命令超时：页面仍在执行 ${client.busyCommandId}（已 ${client.busyMs} ms），主线程还有响应。`)
    logger.error("页面里的 JS 杀不掉，只能重载加载项；页面侧的执行上限见 options.commandTimeoutMs。")
  }
  else if (state.started) {
    logger.error(`命令超时：页面已开始执行但 ${options.timeout} ms 内没有结果（可能是异步任务一直没结束）。`)
  }
  else {
    logger.error(`命令超时（${options.timeout} ms）。`)
  }
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  }
  catch (error) {
    process.stderr.write(`[wps-bridge] ${error.message}\n`)
    process.stderr.write(USAGE)
    return EXIT.failed
  }

  // Ctrl-C 也要把 --start 拉起的 dev server 与 --launch 拉起的 WPS 收拾干净
  const onSignal = (signal) => {
    stopAllServers()
    stopAllWps()
    process.exit(signal === "SIGINT" ? 130 : 143)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    return await run(options)
  }
  catch (error) {
    process.stderr.write(`[wps-bridge] ${error.message}\n`)
    return EXIT.failed
  }
  finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}
