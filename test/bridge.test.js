/**
 * 桥核心（src/bridge.js）的单元测试。
 *
 * 这一层是纯簿记，不碰网络，所以可以精确地测那些最容易出错的边界：
 * 事件环形缓冲、客户端状态推导、命令的目标与去重。端到端见 examples.test.js。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { createBridge, createClientRegistry, createCommandQueue, createEventLog } from "../src/bridge.js"

test("事件日志：环形缓冲只留最近的，并报告丢弃到哪", () => {
  const log = createEventLog(3)
  for (let index = 1; index <= 5; index += 1) log.append({ type: "log", text: `#${index}` })

  assert.equal(log.latestSeq, 5)
  assert.equal(log.droppedBefore, 2)
  assert.deepEqual(log.since(0).map(event => event.text), ["#3", "#4", "#5"])
  assert.deepEqual(log.since(4).map(event => event.text), ["#5"])
  assert.deepEqual(log.since(5), [])
  assert.deepEqual(log.since(999), [])
})

test("事件日志：压实之后序号依然连续", () => {
  const log = createEventLog(2)
  for (let index = 1; index <= 9; index += 1) log.append({ type: "log", text: `#${index}` })

  assert.deepEqual(log.since(7).map(event => event.seq), [8, 9])
  assert.equal(log.droppedBefore, 7)
})

test("事件日志：clear 之后重新从 1 开始", () => {
  const log = createEventLog(10)
  log.append({ type: "log", text: "a" })
  log.clear()
  assert.equal(log.latestSeq, 0)
  assert.equal(log.droppedBefore, 0)
  log.append({ type: "log", text: "b" })
  assert.equal(log.since(0)[0].seq, 1)
})

test("客户端状态：信标与主线程活动是两条独立信号", () => {
  const clients = createClientRegistry({ ttlMs: 10_000, blockedAfterMs: 1_000 })
  const now = 1_000_000

  // 主线程发过 hello / 长轮询：接入，两个时间戳都算“刚刚活过”
  clients.touch("page-1", now)
  assert.equal(clients.list(now)[0].state, "idle")

  clients.markBusy("page-1", "cmd-1", now)
  assert.equal(clients.list(now)[0].state, "busy")
  assert.equal(clients.list(now)[0].busyCommandId, "cmd-1")

  // 长命令只要主线程还在推进（信标如实带着新的 mainTickAt），就是 busy
  clients.markBeacon("page-1", { mainTickAt: now + 900, mode: "worker" }, now + 900)
  assert.equal(clients.list(now + 1_500)[0].state, "busy")

  // 信标照常到达，但 mainTickAt 停在原处：主线程不推进 → stalled
  // （长同步任务与宿主弹窗都会这样，外面分不出是哪种，所以不猜）
  clients.markBeacon("page-1", { mainTickAt: now + 900, mode: "worker" }, now + 2_200)
  const stalled = clients.list(now + 2_500)[0]
  assert.equal(stalled.state, "stalled")
  assert.equal(stalled.mainStallMs, 1_600)
  assert.equal(stalled.beaconAgeMs, 300)
  assert.equal(stalled.beaconMode, "worker")

  // 信标也停了：页面进程没了 → offline（而不是靠“多久没命令”去猜）
  assert.equal(clients.list(now + 3_600)[0].state, "offline")

  // 页面刷新后重新接入，一切照旧
  clients.markBeacon("page-1", { mainTickAt: now + 4_000, mode: "worker" }, now + 4_000)
  assert.equal(clients.list(now + 4_100)[0].state, "busy")
  clients.markIdle("page-1", now + 4_200)
  assert.equal(clients.list(now + 4_300)[0].state, "idle")
})

test("客户端状态：未来的 mainTickAt 不会让 stall 变负数", () => {
  const clients = createClientRegistry({ blockedAfterMs: 1_000 })
  const now = 2_000_000
  clients.markBeacon("page-1", { mainTickAt: now + 999_999, mode: "worker" }, now)
  assert.equal(clients.list(now)[0].mainStallMs, 0)
})

test("客户端登记表：空闲超时会清掉，newest 取接入最晚的那个", () => {
  const clients = createClientRegistry({ ttlMs: 1_000, blockedAfterMs: 500 })
  const now = Date.now()
  clients.touch("page-1", now)
  clients.touch("page-2", now)

  assert.equal(clients.newestId(), "page-2")
  assert.deepEqual(clients.list(now + 500).map(client => client.id), ["page-1", "page-2"])
  assert.deepEqual(clients.list(now + 2_000), [])
  assert.equal(clients.newestId(), null)
})

test("命令队列：指定了目标就不会被别的客户端取走", () => {
  const queue = createCommandQueue({ limit: 4 })
  queue.push({ id: "a", clientId: "page-2" })

  assert.equal(queue.takeFor("page-1"), null)
  assert.equal(queue.takeFor("page-2").id, "a")
  assert.equal(queue.length, 0)
})

test("命令队列：同 id 重发会替换旧的那条，满了要拒绝", () => {
  const queue = createCommandQueue({ limit: 1 })

  assert.equal(queue.push({ id: "a" }), true)
  assert.equal(queue.push({ id: "b" }), false, "队列满时要明确拒绝")
  assert.equal(queue.push({ id: "a" }), true, "同 id 是重发，不该占新位置")
  assert.equal(queue.length, 1)
  assert.equal(queue.list()[0].id, "a")
})

test("桥：命令当场交给正在等待的页面", async () => {
  const bridge = createBridge()
  const waiting = bridge.waitForCommand("page-1", { timeoutMs: 200 })

  const result = bridge.submit({ id: "cmd-1", kind: "eval", code: "return 1" }, { clientId: "page-1" })
  assert.equal(result.ok, true)
  assert.equal(result.queued, false)

  assert.equal((await waiting).id, "cmd-1")
})

test("桥：没有页面等着就先排队，目标不对的页面取不走", async () => {
  const bridge = createBridge()
  const result = bridge.submit({ id: "cmd-2", kind: "eval", code: "return 1" }, { clientId: "page-9" })

  assert.equal(result.queued, true)
  assert.equal(bridge.status().queuedCommands, 1)
  assert.deepEqual(bridge.status().queued, [{ id: "cmd-2", kind: "eval", clientId: "page-9" }])

  assert.equal(await bridge.waitForCommand("page-1", { timeoutMs: 20 }), null)
  assert.equal((await bridge.waitForCommand("page-9", { timeoutMs: 20 })).id, "cmd-2")
})

test("桥：队列满了要明确报错，而不是无限堆积", () => {
  const bridge = createBridge({ maxQueuedCommands: 1 })

  assert.equal(bridge.submit({ id: "a", kind: "eval" }).ok, true)
  const full = bridge.submit({ id: "b", kind: "eval" })
  assert.equal(full.ok, false)
  assert.match(full.error, /队列已满/)
})

test("桥：信标不进事件日志，但会更新客户端状态", () => {
  const bridge = createBridge()
  bridge.record({ type: "hello", clientId: "page-1" })
  const before = bridge.events.latestSeq

  bridge.record({ type: "started", clientId: "page-1", id: "cmd-1" })
  const beacon = bridge.record({ type: "beacon", clientId: "page-1", mode: "worker", mainTickAt: Date.now() })

  assert.equal(beacon, null, "信标不该返回事件记录")
  assert.equal(bridge.events.latestSeq, before + 1, "只有 started 进了日志")
  const client = bridge.status().clients[0]
  assert.equal(client.state, "busy")
  assert.equal(client.beaconMode, "worker")

  bridge.record({ type: "result", clientId: "page-1", id: "cmd-1", ok: true })
  assert.equal(bridge.status().clients[0].state, "idle")
})

test("桥：页面刷新断掉长轮询后，等待位会被释放", async () => {
  const bridge = createBridge()
  const waiting = bridge.waitForCommand("page-1", { timeoutMs: 10_000 })

  // 模拟 AbortSignal（HTTP 适配层用 request 的 close 事件触发）
  const controller = new AbortController()
  const waitingWithSignal = bridge.waitForCommand("page-1", { timeoutMs: 10_000, signal: controller.signal })
  assert.equal(await waiting, null, "同一客户端的新等待位会顶掉旧的")
  controller.abort()
  assert.equal(await waitingWithSignal, null)

  const disposing = bridge.waitForCommand("page-1", { timeoutMs: 10_000 })
  bridge.dispose()
  assert.equal(await disposing, null)
})

test("桥：waitForEvents 只给游标之后的事件", async () => {
  const bridge = createBridge()
  bridge.record({ type: "log", text: "a" })
  bridge.record({ type: "log", text: "b" })

  assert.deepEqual((await bridge.waitForEvents(0, 50)).map(event => event.text), ["a", "b"])
  assert.deepEqual((await bridge.waitForEvents(2, 50)).map(event => event.text), [])

  // 挂起等着，来了新事件立刻唤醒
  const pending = bridge.waitForEvents(2, 1_000)
  bridge.record({ type: "log", text: "c" })
  assert.deepEqual((await pending).map(event => event.text), ["c"])
})
