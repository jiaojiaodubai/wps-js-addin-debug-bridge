/**
 * HTTP 适配层（src/server.js）的单元测试：路由、把关、端口文件、注入。
 * 端到端（真的跑加载项页面）见 examples.test.js。
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  API_PREFIX,
  CLIENT_SCRIPT_PATH,
  DEFAULT_PORT_FILE,
  PROTOCOL_MODULE_PATH,
  PROTOCOL_VERSION,
} from "../src/protocol.js"
import {
  bridgeClientOptions,
  createBridgeMiddleware,
  defaultOriginGuard,
  injectBridgeClient,
  isLoopbackHost,
  portFromHost,
} from "../src/server.js"

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** 把中间件挂在真实的 http 服务上（和示例的 dev server 用同一套接法）。 */
async function startServer(options = {}) {
  const bridge = createBridgeMiddleware({ portFile: false, ...options })
  const server = createServer((request, response) => {
    bridge.handle(request, response, () => {
      response.statusCode = 404
      response.end("not found")
    })
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  bridge.announce(port)
  return {
    bridge,
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await bridge.dispose()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function getJson(url, init) {
  return fetch(url, init).then(response => response.json())
}

async function postJson(url, body, init) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    ...init,
  }).then(response => response.json())
}

/** 等长轮询确实挂上等待位，再把命令投递过去（本地回环下基本第一次就成）。 */
async function pollThenSubmit(base, command) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const polling = getJson(`${base}${API_PREFIX}/poll?client=page-test`)
    await delay(150)
    const submit = await postJson(`${base}${API_PREFIX}/submit`, command)
    if (submit.queued === false) return { submit, polled: await polling }
    // 命令排进了队列，会被这次轮询取走；下一轮再来
    await polling
  }
  throw new Error("没能把命令投递给等待中的页面")
}

test("路由：非桥路径一律交给后面的处理逻辑", async () => {
  const { base, close } = await startServer()
  try {
    const response = await fetch(`${base}/index.html`)
    assert.equal(response.status, 404)
    assert.equal(await response.text(), "not found")
  }
  finally {
    await close()
  }
})

test("路由：提供页面侧需要的两个脚本，别的文件不给", async () => {
  const { base, close } = await startServer()
  try {
    const client = await fetch(`${base}${CLIENT_SCRIPT_PATH}`)
    assert.equal(client.status, 200)
    assert.match(client.headers.get("content-type"), /javascript/)
    assert.match(await client.text(), /__wpsDebugBridgeOptions/)

    assert.equal((await fetch(`${base}${PROTOCOL_MODULE_PATH}`)).status, 200)
    // 只开放这两个文件，包的其余内容不该被 dev server 暴露出去
    assert.equal((await fetch(`${base}/__wps_debug_bridge/assets/runner.js`)).status, 404)
  }
  finally {
    await close()
  }
})

test("接口：submit → poll → report → events 走通一遍", async () => {
  const { base, close } = await startServer()
  try {
    const { submit, polled } = await pollThenSubmit(base, { id: "cmd-1", kind: "click", controlId: "btnHello" })

    assert.equal(submit.id, "cmd-1")
    assert.equal(polled.command.controlId, "btnHello")
    assert.equal(polled.command.useHook, true, "默认启用页面钩子")

    await postJson(`${base}${API_PREFIX}/report`, {
      client: "page-test",
      event: { type: "log", level: "log", text: "tests=2 passed=2 failed=0" },
    })

    const events = await getJson(`${base}${API_PREFIX}/events?since=0`)
    assert.deepEqual(events.events.map(event => event.type), ["submitted", "log"])
    assert.equal(events.events[1].seq, 2)
    assert.equal(events.droppedBefore, 0)
  }
  finally {
    await close()
  }
})

test("接口：没有页面时命令排队，status 能看见（含客户端状态）", async () => {
  const { base, close } = await startServer()
  try {
    const submit = await postJson(`${base}${API_PREFIX}/submit`, { kind: "eval", code: "return 1" })
    assert.equal(submit.queued, true, "没有页面在等时应当排队")

    const queued = await getJson(`${base}${API_PREFIX}/status`)
    assert.deepEqual(queued.clients, [])
    assert.equal(queued.queuedCommands, 1)
    assert.equal(queued.protocol, PROTOCOL_VERSION)

    // 页面接入后：排队的命令会被下发给它，状态也能看到“空闲”
    const polled = await getJson(`${base}${API_PREFIX}/poll?client=page-late`)
    assert.equal(polled.command.code, "return 1")

    const status = await getJson(`${base}${API_PREFIX}/status`)
    assert.deepEqual(status.clients.map(client => client.id), ["page-late"])
    assert.equal(status.clients[0].state, "idle")
    assert.ok(status.clients[0].idleMs < 5_000)
  }
  finally {
    await close()
  }
})

test("接口：队列满了明确报错（429），而不是无限堆积", async () => {
  const { base, close } = await startServer({ maxQueuedCommands: 1 })
  try {
    assert.equal((await postJson(`${base}${API_PREFIX}/submit`, { kind: "eval", code: "1" })).queued, true)

    const response = await fetch(`${base}${API_PREFIX}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "eval", code: "2" }),
    })
    assert.equal(response.status, 429)
    assert.match((await response.json()).error, /队列已满/)
  }
  finally {
    await close()
  }
})

test("接口：reset 清空队列与事件", async () => {
  const { base, close } = await startServer()
  try {
    await postJson(`${base}${API_PREFIX}/submit`, { kind: "eval", code: "return 1" })
    await postJson(`${base}${API_PREFIX}/report`, { client: "page-test", event: { type: "log", text: "hi" } })

    assert.equal((await postJson(`${base}${API_PREFIX}/reset`)).ok, true)

    const status = await getJson(`${base}${API_PREFIX}/status`)
    assert.equal(status.queuedCommands, 0)
    assert.equal(status.eventSeq, 0)
    assert.deepEqual(status.clients, [])
  }
  finally {
    await close()
  }
})

test("接口：dispose 会放掉挂着的长轮询，不让进程干等", async () => {
  const { base, bridge, close } = await startServer()
  try {
    const polling = getJson(`${base}${API_PREFIX}/poll?client=page-test`)
    await delay(100)
    bridge.dispose()
    assert.deepEqual(await polling, { command: null })
  }
  finally {
    await close()
  }
})

test("接口：未知接口返回 404", async () => {
  const { base, close } = await startServer()
  try {
    const response = await fetch(`${base}${API_PREFIX}/nope`)
    assert.equal(response.status, 404)
    assert.match((await response.json()).error, /未知的桥接口/)
  }
  finally {
    await close()
  }
})

test("把关：跨站页面调不动桥（Origin 不同源 → 403）", async () => {
  const { base, close } = await startServer()
  try {
    const response = await fetch(`${base}${API_PREFIX}/status`, { headers: { Origin: "https://evil.example" } })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /只接受本机同源调用/)
  }
  finally {
    await close()
  }
})

test("把关：token 打开后，不带就不给调", async () => {
  const { base, port, close } = await startServer({ token: "s3cret" })
  try {
    assert.equal((await fetch(`${base}${API_PREFIX}/status`)).status, 401)
    assert.equal((await fetch(`${base}${API_PREFIX}/status`, { headers: { "x-wps-bridge-token": "s3cret" } })).status, 200)
    assert.equal((await fetch(`${base}${API_PREFIX}/status?token=s3cret`)).status, 200)

    // 注入到页面里的选项要带上 token，否则页面自己会被挡住
    assert.equal(bridgeClientOptions({ token: "s3cret" }).token, "s3cret")
    assert.match(injectBridgeClient("<body></body>", { token: "s3cret" }), /"token":"s3cret"/)
    assert.ok(port > 0)
  }
  finally {
    await close()
  }
})

test("把关：放行规则是纯函数，便于按需替换", () => {
  assert.equal(isLoopbackHost("localhost:3889"), true)
  assert.equal(isLoopbackHost("127.0.0.1:3889"), true)
  assert.equal(isLoopbackHost("127.5.5.5"), true)
  assert.equal(isLoopbackHost("[::1]:3889"), true)
  assert.equal(isLoopbackHost("192.168.1.5:3889"), false)
  assert.equal(isLoopbackHost("evil.example"), false)

  assert.equal(defaultOriginGuard({ host: "127.0.0.1:3889" }), true, "终端（没有 Origin）放行")
  assert.equal(defaultOriginGuard({ host: "127.0.0.1:3889", origin: "http://127.0.0.1:3889" }), true)
  assert.equal(defaultOriginGuard({ host: "127.0.0.1:3889", origin: "https://evil.example" }), false)
  assert.equal(defaultOriginGuard({ host: "evil.example", origin: "http://evil.example" }), false, "DNS rebinding：Host 不是本机就挡掉")

  assert.equal(portFromHost("127.0.0.1:3889"), 3889)
  assert.equal(portFromHost("[::1]:3889"), 3889)
  assert.equal(portFromHost("localhost"), 0)
})

test("端口文件：announce 写出来，dispose 收回去", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wps-bridge-port-"))
  const file = path.join(dir, DEFAULT_PORT_FILE)
  const { bridge, port, close } = await startServer({ portFile: file, token: true })
  try {
    let info = null
    for (let attempt = 0; attempt < 20 && !info; attempt += 1) {
      info = await readFile(file, "utf8").then(JSON.parse).catch(() => null)
      if (!info) await delay(20)
    }
    assert.ok(info, "端口文件应当被写出来")
    assert.equal(info.port, port)
    assert.equal(info.protocol, PROTOCOL_VERSION)
    assert.equal(info.pid, process.pid)
    assert.ok(info.token, "开了 token 时也要写进去，终端才拿得到")

    await bridge.dispose()
    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/)
  }
  finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("端口文件：知道自己端口时按自己的写，别的进程的不动", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wps-bridge-port-"))
  const file = path.join(dir, DEFAULT_PORT_FILE)
  const first = await startServer({ portFile: file })
  try {
    await delay(50)
    // 另一个 dev server 后来居上（模拟同一个项目里跑了两个）
    await writeFile(file, JSON.stringify({ port: 1, pid: 999_999 }), "utf8")
    await first.bridge.dispose()
    // 不是自己写的就不要删
    assert.equal(JSON.parse(await readFile(file, "utf8")).pid, 999_999)
  }
  finally {
    await first.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("注入 HTML：默认等 Ribbon 回调，靠版本号避免缓存旧客户端", () => {
  const injected = injectBridgeClient("<html><body></body></html>")
  assert.match(injected, /typeof window\.OnAction === 'function'/)
  assert.match(injected, new RegExp(`${CLIENT_SCRIPT_PATH.replace(/[/@]/g, "\\$&")}\\?v=${PROTOCOL_VERSION}`))
  assert.match(injectBridgeClient("<p>无 body</p>"), /无 body[\s\S]*client\.js/)

  assert.match(injectBridgeClient("<body></body>", { readyCheck: "window.ready === true" }), /window\.ready === true/)
  assert.match(injectBridgeClient("<body></body>", { commandTimeoutMs: 5_000 }), /"commandTimeoutMs":5000/)
})
