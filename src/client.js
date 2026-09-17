/**
 * 桥的页面侧客户端。
 *
 * 由 dev server 注入到开发服务器的页面里（见 src/vite-plugin.js 与 src/server.js），
 * 只在开发期存在。它让终端里的运行器能够：
 *   1. 触发页面上的入口（例如 WPS 加载项的 Ribbon 回调，等价于“替用户点一下按钮”）；
 *   2. 在运行中的页面里临时 import 并调用任意模块函数；
 *   3. 把页面内的 console 输出与提示回传到终端。
 *
 * 四件容易被忽略、但决定“用起来是不是玄学”的事：
 *   - **命令会被重发**（页面没及时确认 / 终端重试），所以按 id 去重：
 *     同一条命令只执行一次，重发时补发上次的结果；
 *   - **页面里的 JS 杀不掉**，所以给每条命令加执行上限，超时就明确报错，
 *     而不是让终端干等到全局超时；
 *   - **信标必须放在独立线程**：页面只有一个 JS 线程，长任务的同步段（WPS 宿主
 *     调用基本都是同步的）会把定时器饿死，主线程心跳看起来和被宿主弹窗冻结一样。
 *     所以信标由 Web Worker 发送，并带上主线程的 mainTickAt（见 startBeacons）；
 *   - **日志带上命令 id**，多命令/多页面时不至于分不清哪条日志是谁的。
 *
 * 命令协议见 src/protocol.js，服务端在 src/server.js，终端侧在 src/runner.js。
 */

import { API_PREFIX, HOOK_GLOBAL, PROTOCOL_VERSION } from "./protocol.js"

const CLIENT_ID = `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const RETRY_DELAY_MS = 1_000
const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_HEARTBEAT_MS = 5_000
const READY_POLL_MS = 250
/** 记住最近若干条命令的结果：命令被重发时补发结果，不重复执行。 */
const EXECUTED_LIMIT = 50

const options = globalThis.__wpsDebugBridgeOptions ?? {}
const readyCheckSource = typeof options.readyCheck === "string" && options.readyCheck.trim()
  ? options.readyCheck
  : "true"
const readyTimeoutMs = Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS
const commandTimeoutMs = Number(options.commandTimeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS
const heartbeatMs = Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS
const token = typeof options.token === "string" ? options.token : ""

let started = false
let readyCheckFailed = false
/** 正在执行的命令 id：页面里命令是串行的，一个当前值就够（也是日志归属的依据）。 */
let currentCommandId = null

/** 最近执行过的命令结果（有界，够覆盖重试窗口即可）。 */
const executed = new Map()

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function stringify(value) {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function bridgeHeaders() {
  const headers = { "Content-Type": "application/json" }
  if (token) headers["x-wps-bridge-token"] = token
  return headers
}

/**
 * 回传一条事件。桥断了不应该影响页面逻辑，因此发送失败一律静默。
 * 事件按顺序串行发送：并发 fetch 到达服务端的顺序不保证，会让终端里的日志乱序。
 * @param {Record<string, unknown>} event
 */
let reportQueue = Promise.resolve()

function report(event) {
  reportQueue = reportQueue
    .then(() => fetch(`${API_PREFIX}/report`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify({ client: CLIENT_ID, event }),
      keepalive: true,
    }))
    .catch(() => {})
  return reportQueue
}

function patchConsole() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      report({ type: "log", level, text: args.map(stringify).join(" "), commandId: currentCommandId })
    }
  }
}

/**
 * 信标（beacon）：页面进程与主线程各报各的。
 *
 * 为什么不用“主线程定时器 + fetch”当心跳：页面只有一个 JS 线程，长任务的同步段
 * 会把定时器饿死 —— 心跳发不出去，看起来和被弹窗冻结一样，终端只能靠人去看有没有弹窗。
 * 所以信标改由 Web Worker（独立线程）发送：
 *   - 信标本身按时到达，证明“页面进程还活着”；
 *   - 信标里的 mainTickAt（主线程最近一次 tick），证明“主线程还在推进”。
 * 服务端把两条信号分开解读：信标停了 = 失联；信标在、主线程不推进 = 无响应。
 * 真正的“为什么卡住”（长同步任务 vs 宿主弹窗）从外面分不出来，所以也不装作分得出来。
 *
 * Worker 起不来时（宿主内核裁剪 / CSP / 页面模拟器）退回主线程信标：
 * 功能仍然可用，只是重新受同步任务影响（此时“失联”可能只是被饿死）。
 */
const BEACON_WORKER_SOURCE = `
let heartbeatMs = 5000
let clientId = ""
let url = ""
let headers = {}
let lastTickAt = 0
self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === "init") {
    heartbeatMs = message.heartbeatMs || heartbeatMs
    clientId = message.clientId
    url = message.url
    headers = message.headers || {}
    lastTickAt = Date.now()
    self.postMessage({ type: "ready" })
    setInterval(send, heartbeatMs)
    send()
  }
  else if (message.type === "tick") {
    lastTickAt = Date.now()
  }
}
function send() {
  if (!url) return
  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ client: clientId, event: { type: "beacon", mode: "worker", mainTickAt: lastTickAt } }),
    keepalive: true,
  }).catch(() => {})
}
`

/** 主线程兜底信标：Worker 不可用时才走这条路。 */
function startMainBeacon() {
  return setInterval(() => {
    report({ type: "beacon", mode: "main", mainTickAt: Date.now() })
  }, heartbeatMs)
}

/** 启动信标；返回计时器（只是留着，页面生命周期内一直跑）。 */
function startBeacons() {
  try {
    if (typeof Worker === "function" && typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
      const workerUrl = URL.createObjectURL(new Blob([BEACON_WORKER_SOURCE], { type: "text/javascript" }))
      const worker = new Worker(workerUrl)
      let workerTicker = null
      let fellBack = false
      worker.onmessage = () => URL.revokeObjectURL(workerUrl)
      worker.onerror = () => {
        // 起不来（CSP、内核裁剪…）：退回主线程信标，别让桥这边直接“失联”
        if (fellBack) return
        fellBack = true
        clearInterval(workerTicker)
        try {
          worker.terminate()
        }
        catch {
          // 忽略
        }
        URL.revokeObjectURL(workerUrl)
        startMainBeacon()
      }
      worker.postMessage({
        type: "init",
        clientId: CLIENT_ID,
        heartbeatMs,
        url: new URL(`${API_PREFIX}/report`, location.href).href,
        headers: bridgeHeaders(),
      })
      workerTicker = setInterval(() => worker.postMessage({ type: "tick" }), heartbeatMs)
      return workerTicker
    }
  }
  catch {
    // 宿主不支持 Worker：走下面的主线程兜底
  }
  return startMainBeacon()
}

function isPageReady() {
  try {
    // readyCheck 由宿主项目以字符串给出（例如等待 WPS 加载项挂上 Ribbon 回调）。
    // eslint-disable-next-line no-new-func
    return Boolean(new Function(`return (${readyCheckSource})`)())
  }
  catch (error) {
    // 表达式写错时不要默默当成“已就绪”，否则只会表现为命令永远没人执行。
    if (!readyCheckFailed) {
      readyCheckFailed = true
      report({ type: "log", level: "error", text: `readyCheck 表达式有误，暂按“已就绪”处理：${error.message}` })
    }
    return true
  }
}

async function waitForPageReady() {
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    if (isPageReady()) return true
    await delay(READY_POLL_MS)
  }
  return false
}

/**
 * 页面级钩子：加载项可以选择把非阻塞提示（例如测试汇总弹窗）交给它，
 * 避免 `alert` 冻结页面（宿主常把 window.alert 定义成不可写、不可重定义的属性）。
 */
function installHook() {
  const previous = globalThis[HOOK_GLOBAL]
  globalThis[HOOK_GLOBAL] = {
    ...(previous && typeof previous === "object" ? previous : {}),
    clientId: CLIENT_ID,
    protocol: PROTOCOL_VERSION,
    notify: text => report({ type: "log", level: "hook", text: stringify(text) }),
  }
}

function removeHook() {
  if (globalThis[HOOK_GLOBAL]?.clientId === CLIENT_ID) delete globalThis[HOOK_GLOBAL]
}

function normalizeModulePath(modulePath) {
  if (/^(https?:)?\/\//.test(modulePath) || modulePath.startsWith("/")) return modulePath
  return `/${modulePath}`
}

/** 页面里的 JS 没法强杀，但至少让终端立刻拿到明确失败，而不是干等到全局超时。 */
function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`命令在页面里执行超过 ${timeoutMs} ms（${label}）`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function executeCommand(command) {
  const run = async () => {
    switch (command.kind) {
      case "click": {
        // 走宿主页面自己的入口（WPS 加载项由 ribbon 回调把 OnAction 挂到 window 上）。
        const handler = globalThis.OnAction
        if (typeof handler !== "function") {
          throw new Error("页面里没有 OnAction，无法触发 Ribbon 入口")
        }
        return await handler({ Id: command.controlId }, undefined)
      }
      case "call": {
        const module = await import(/* @vite-ignore */ normalizeModulePath(command.module))
        const fn = module[command.fn]
        if (typeof fn !== "function") {
          throw new Error(`模块 ${command.module} 未导出函数 ${command.fn}`)
        }
        return await fn(...(command.args ?? []))
      }
      case "run": {
        // 执行指定模块文件（dev server 负责编译，因此 .ts 也能直接跑）：
        // 先让模块副作用生效，再调用它的 default / main 导出（可用 --export 指定）。
        const module = await import(/* @vite-ignore */ normalizeModulePath(command.file))
        const entry = command.exportName
          ? module[command.exportName]
          : [module.default, module.main].find(value => typeof value === "function")
        if (typeof entry !== "function") {
          if (command.exportName) {
            throw new Error(`模块 ${command.file} 未导出函数 ${command.exportName}`)
          }
          // 没有入口函数：模块副作用已经跑过，把导出列表回报给调用方。
          return { exports: Object.keys(module) }
        }
        return await entry(...(command.args ?? []))
      }
      case "eval": {
        // eslint-disable-next-line no-new-func
        const fn = new Function("importModule", `return (async () => { ${command.code} })()`)
        return await fn(modulePath => import(/* @vite-ignore */ normalizeModulePath(modulePath)))
      }
      default:
        throw new Error(`未知的桥命令：${command.kind}`)
    }
  }

  if (command.useHook === false) {
    // --no-hook：临时摘掉钩子，恢复加载项自身的模态提示。
    removeHook()
    try {
      return await run()
    }
    finally {
      installHook()
    }
  }
  return run()
}

/** 记下结果（供重发时补发），并回报给终端。 */
function settle(command, outcome) {
  executed.set(command.id, outcome)
  while (executed.size > EXECUTED_LIMIT) {
    executed.delete(executed.keys().next().value)
  }
  report({ type: "result", id: command.id, ...outcome })
}

async function handleCommand(command) {
  const previous = executed.get(command.id)
  if (previous) {
    // 重发：补一个 started + 上次的结果，绝不重复执行（否则会重复写文档、重复发请求）
    report({ type: "started", id: command.id, kind: command.kind, replayed: true })
    report({ type: "result", id: command.id, replayed: true, ...previous })
    return
  }

  const startedAt = performance.now()
  // 回报“已收到”：长轮询可能把命令交给一个刚好刷新的页面，运行器据此重发。
  report({ type: "started", id: command.id, kind: command.kind })

  // 执行期间不需要单独发“我还活着”：信标（beacon）一直在跑，主线程的
  // mainTickAt 会如实反映同步段有没有把线程占满。
  currentCommandId = command.id

  try {
    const value = await withTimeout(executeCommand(command), commandTimeoutMs, command.kind)
    settle(command, {
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      value: value === undefined ? undefined : stringify(value),
    })
  }
  catch (error) {
    settle(command, {
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: stringify(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  finally {
    currentCommandId = null
  }
}

async function pollOnce() {
  const response = await fetch(
    `${API_PREFIX}/poll?client=${encodeURIComponent(CLIENT_ID)}`,
    { cache: "no-store", headers: bridgeHeaders() },
  )
  if (!response.ok) throw new Error(`桥返回 ${response.status}`)
  const payload = await response.json()
  if (payload?.command) await handleCommand(payload.command)
}

async function loop() {
  for (;;) {
    try {
      await pollOnce()
    }
    catch {
      await delay(RETRY_DELAY_MS)
    }
  }
}

async function start() {
  if (started) return
  started = true
  patchConsole()
  if (!await waitForPageReady()) {
    started = false
    return
  }
  installHook()
  startBeacons()
  report({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    url: location.href,
    userAgent: navigator.userAgent,
    title: document.title,
  })
  await loop()
}

void start()
