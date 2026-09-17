/**
 * 桥的核心：命令队列、事件日志、客户端登记表。
 *
 * 这些是“容易出错的簿记”，所以单独一层，不掺 HTTP、也不掺构建工具：
 *   - src/server.js 把它接到 HTTP 上；
 *   - src/runner.js 是终端侧的另一半。
 *
 * 三个设计点（都是踩过的坑）：
 *   1. **命令有目标**：不再“谁先来轮询谁执行”，默认只发给终端指定的那个页面，
 *      否则 WPS 单实例下残留的旧页面会抢走命令；
 *   2. **命令会被重发**：所以页面侧要能按 id 去重（见 src/client.js），
 *      这里只负责保证同一条命令不会被同一个客户端取走两次；
 *   3. **事件日志是环形的**：有上限、能报告“更早的已经丢了”，
 *      而不是静默丢弃后让终端的游标永远追不上。
 */

import { CLIENT_TTL_MS, describeCommand } from "./protocol.js"

/**
 * 两个“多久没动静算异常”共用的时间常数（默认信标间隔 5 s 的 3 倍，容忍漏两拍）。
 *
 * 信标由页面里的 Web Worker 发送，长任务的同步段饿不死它，所以信标停了基本就是
 * “页面进程没了”（offline）；信标还在、但 mainTickAt 不动，则是“主线程不推进”
 * （stalled：长同步任务或宿主弹窗，外面分不出是哪种，就不猜）。
 * 15 s 同时与 Chromium 判定页面无响应的桌面阈值一致
 * （components/input/input_constants.h 的 kHungRendererDelay）。
 */
export const DEFAULT_BLOCKED_AFTER_MS = 15_000

/** 默认事件日志容量。 */
export const DEFAULT_EVENT_LIMIT = 5_000

/** 默认命令队列上限。 */
export const DEFAULT_QUEUE_LIMIT = 1_000

/** 不进事件日志的控制事件：信标/签到只用来更新客户端状态，不该污染日志流。 */
const EPHEMERAL_EVENTS = new Set(["beacon", "busy", "seen"])

/**
 * 有上限的事件日志（环形缓冲）。
 *
 * `since()` 是 O(取出的条数)：靠“下标 + 基准序号”直接定位，
 * 不像朴素实现那样每次都对整个数组做 filter。
 */
export function createEventLog(limit = DEFAULT_EVENT_LIMIT) {
  let buffer = []
  let start = 0
  /** buffer[start].seq - 1，也就是“已经丢弃到哪一条”。 */
  let baseSeq = 0
  let seq = 0

  return {
    get latestSeq() {
      return seq
    },

    /** 早于该序号的事件已经被丢弃（调用方可以据此提示日志有断层）。 */
    get droppedBefore() {
      return baseSeq
    },

    append(event) {
      seq += 1
      const record = { seq, at: new Date().toISOString(), ...event }
      buffer.push(record)
      while (buffer.length - start > limit) {
        start += 1
        baseSeq = buffer[start - 1].seq
      }
      // 定期压实，避免数组无限长下去
      if (start >= limit) {
        buffer = buffer.slice(start)
        start = 0
      }
      return record
    },

    /** @returns 序号大于 sinceSeq 的事件（若已被丢弃，就只给还留着的那些）。 */
    since(sinceSeq = 0) {
      const offset = Math.max(0, sinceSeq - baseSeq)
      return buffer.slice(start + offset)
    },

    clear() {
      buffer = []
      start = 0
      baseSeq = 0
      seq = 0
    },
  }
}

/**
 * 客户端登记表：谁接上了、信标还新不新、主线程还在不在推进、有没有命令在执行。
 *
 * 状态是**推导**出来的，不是页面自己声明的，而且靠的是两条独立信号：
 *   idle    信标正常、主线程在推进、没有命令在执行；
 *   busy    有命令在执行，且主线程还在推进（长命令也能看出来）；
 *   stalled 信标正常（页面进程还在），但主线程超过阈值没有推进 ——
 *           长同步任务与宿主弹窗都会这样，从外面分不出是哪种，所以不猜；
 *   offline 信标停了 —— 页面进程没了（关闭、崩溃）。
 * 这样终端就不用靠“45 s 空闲宽限”去猜了。
 */
export function createClientRegistry({ ttlMs = CLIENT_TTL_MS, blockedAfterMs = DEFAULT_BLOCKED_AFTER_MS } = {}) {
  const clients = new Map()
  /** 接入顺序；最后一个就是“最新”。 */
  const connected = []

  function ensure(id) {
    let client = clients.get(id)
    if (!client) {
      const now = Date.now()
      client = {
        id,
        connectedAt: now,
        lastSeen: now,
        lastBeacon: now,
        mainTickAt: now,
        beaconMode: "",
        busyCommandId: null,
        busySince: 0,
      }
      clients.set(id, client)
      connected.push(id)
    }
    return client
  }

  function prune(now) {
    for (const [id, client] of [...clients]) {
      if (now - client.lastSeen <= ttlMs) continue
      clients.delete(id)
      const index = connected.indexOf(id)
      if (index !== -1) connected.splice(index, 1)
    }
  }

  function stateOf(client, now) {
    // 信标来自独立线程：它停了就是页面真没了（不是被长任务饿死）
    if (now - client.lastBeacon > blockedAfterMs) return "offline"
    // 信标在、主线程不推进：长同步任务与宿主弹窗都可能，不装能分清
    if (now - client.mainTickAt > blockedAfterMs) return "stalled"
    return client.busyCommandId ? "busy" : "idle"
  }

  return {
    touch(id, now = Date.now()) {
      const client = ensure(id)
      // 能发事件的都是主线程（长轮询、日志、命令生命周期），顺便记为“主线程还活着”
      client.lastSeen = now
      client.mainTickAt = now
      return client
    },

    /** 收到 started：页面开始执行命令。 */
    markBusy(id, commandId, now = Date.now()) {
      const client = ensure(id)
      client.busyCommandId = commandId
      client.busySince = now
      client.lastSeen = now
      client.mainTickAt = now
      return client
    },

    /** 收到 result：命令结束。 */
    markIdle(id, now = Date.now()) {
      const client = ensure(id)
      client.busyCommandId = null
      client.busySince = 0
      client.lastSeen = now
      client.mainTickAt = now
      return client
    },

    /** 收到 beacon（页面任意线程发出）：更新信标与主线程的最后活动时间。 */
    markBeacon(id, { mainTickAt, mode } = {}, now = Date.now()) {
      const client = ensure(id)
      const tick = Number(mainTickAt)
      client.lastBeacon = now
      client.lastSeen = now
      if (Number.isFinite(tick) && tick > 0) client.mainTickAt = Math.min(tick, now)
      if (mode) client.beaconMode = String(mode)
      return client
    },

    newestId() {
      prune(Date.now())
      return connected.at(-1) ?? null
    },

    has(id) {
      prune(Date.now())
      return clients.has(id)
    },

    list(now = Date.now()) {
      prune(now)
      return [...clients.values()].map(client => ({
        id: client.id,
        state: stateOf(client, now),
        idleMs: now - client.lastSeen,
        beaconAgeMs: now - client.lastBeacon,
        mainStallMs: now - client.mainTickAt,
        beaconMode: client.beaconMode || null,
        busyCommandId: client.busyCommandId,
        busyMs: client.busySince ? now - client.busySince : 0,
      }))
    },

    clear() {
      clients.clear()
      connected.length = 0
    },
  }
}

/**
 * 命令队列。同一条命令只会被同一个客户端取走一次；
 * 命令可以指定 clientId（默认不指定：谁先来轮询谁执行，供脚本化调用）。
 */
export function createCommandQueue({ limit = DEFAULT_QUEUE_LIMIT } = {}) {
  const commands = []

  return {
    get length() {
      return commands.length
    },
    get limit() {
      return limit
    },

    /** @returns {boolean} 满了就返回 false —— 调用方必须明确报错，而不是无限堆积。 */
    push(command) {
      // 同 id 视作重发（终端重试会复用 id），换掉旧的那条，不重复排队
      const existing = commands.findIndex(item => item.id === command.id)
      if (existing !== -1) commands.splice(existing, 1)
      if (commands.length >= limit) return false
      commands.push(command)
      return true
    },

    /** 取走该客户端可以执行的第一条命令（FIFO）。 */
    takeFor(clientId) {
      const index = commands.findIndex(command => !command.clientId || command.clientId === clientId)
      if (index === -1) return null
      return commands.splice(index, 1)[0]
    },

    /** 命令结束后从队列里摘掉（对已下发的命令是幂等的）。 */
    markDone(id) {
      const index = commands.findIndex(command => command.id === id)
      if (index !== -1) commands.splice(index, 1)
    },

    list() {
      return [...commands]
    },

    clear() {
      commands.length = 0
    },
  }
}

/**
 * 把三块簿记组装成一个桥。
 *
 * @param {object} [options]
 * @param {number} [options.eventBufferSize] 事件日志容量
 * @param {number} [options.maxQueuedCommands] 命令队列上限
 * @param {number} [options.clientTtlMs] 客户端空闲多久算断开
 * @param {number} [options.blockedAfterMs] 信标/主线程多久没动静算异常
 */
export function createBridge(options = {}) {
  const events = createEventLog(options.eventBufferSize ?? DEFAULT_EVENT_LIMIT)
  const clients = createClientRegistry({
    ttlMs: options.clientTtlMs ?? CLIENT_TTL_MS,
    blockedAfterMs: options.blockedAfterMs ?? DEFAULT_BLOCKED_AFTER_MS,
  })
  const queue = createCommandQueue({ limit: options.maxQueuedCommands ?? DEFAULT_QUEUE_LIMIT })

  /** clientId -> 释放长轮询等待位的函数（一个客户端同时只有一个等待位）。 */
  const commandWaiters = new Map()
  const eventWaiters = new Set()

  function wakeEventWaiters() {
    for (const waiter of [...eventWaiters]) waiter()
  }

  /** 把队列里的命令交给正在等它的长轮询。 */
  function dispatch() {
    for (const [clientId, deliver] of [...commandWaiters]) {
      const command = queue.takeFor(clientId)
      if (!command) continue
      commandWaiters.delete(clientId)
      deliver(command)
    }
  }

  /**
   * 记一条来自页面的上报：先更新客户端状态，再进事件日志。
   * @returns 事件记录；心跳这类控制事件不进日志（返回 null）。
   */
  function record(event) {
    if (event.clientId) {
      if (event.type === "started") clients.markBusy(event.clientId, event.id)
      else if (event.type === "result") clients.markIdle(event.clientId)
      else if (event.type === "beacon") clients.markBeacon(event.clientId, event)
      else clients.touch(event.clientId)
    }
    if (EPHEMERAL_EVENTS.has(event.type)) return null

    const record_ = events.append(event)
    wakeEventWaiters()
    return record_
  }

  function finishWaiter(clientId, command) {
    const deliver = commandWaiters.get(clientId)
    if (!deliver) return false
    commandWaiters.delete(clientId)
    deliver(command)
    return true
  }

  return {
    events,
    clients,
    queue,
    record,

    status() {
      return {
        clients: clients.list(),
        queuedCommands: queue.length,
        queued: queue.list().map(command => ({ id: command.id, kind: command.kind, clientId: command.clientId ?? null })),
        eventSeq: events.latestSeq,
        droppedBefore: events.droppedBefore,
      }
    },

    /** 下发命令；返回是否进了队列（进了就说明还没交到页面手上）。 */
    submit(command, { clientId } = {}) {
      const target = clientId ?? command.clientId
      const full = target ? { ...command, clientId: target } : { ...command }
      if (!queue.push(full)) {
        return {
          ok: false,
          error: `命令队列已满（上限 ${queue.limit} 条）：页面可能没在消费命令，用 status 看看它是不是 blocked`,
        }
      }
      record({ type: "submitted", id: full.id, kind: full.kind, clientId: full.clientId, summary: describeCommand(full) })
      dispatch()
      return { ok: true, id: full.id, queued: queue.list().some(item => item.id === full.id) }
    },

    /**
     * 取出该客户端要执行的命令；没有就挂起等（长轮询）。
     * @param {string} clientId
     * @param {{ timeoutMs: number, signal?: AbortSignal }} options
     */
    waitForCommand(clientId, { timeoutMs, signal } = {}) {
      const immediate = queue.takeFor(clientId)
      if (immediate) return Promise.resolve(immediate)

      // 同一客户端只会有一个等待位：旧的先放掉，避免命令被交给“已经消失的轮询”
      finishWaiter(clientId, null)

      return new Promise((resolve) => {
        let timer = null
        const deliver = (command) => {
          clearTimeout(timer)
          signal?.removeEventListener?.("abort", onAbort)
          resolve(command)
        }
        const onAbort = () => {
          commandWaiters.delete(clientId)
          deliver(null)
        }
        timer = setTimeout(() => {
          commandWaiters.delete(clientId)
          deliver(null)
        }, timeoutMs)
        commandWaiters.set(clientId, deliver)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }
      })
    },

    /** 主动放掉某个客户端的等待位（例如页面刷新断了长轮询）。 */
    cancelWait(clientId) {
      return finishWaiter(clientId, null)
    },

    waitForEvents(sinceSeq, timeoutMs) {
      const pending = events.since(sinceSeq)
      if (pending.length > 0) return Promise.resolve(pending)

      return new Promise((resolve) => {
        const waiter = () => {
          clearTimeout(timer)
          eventWaiters.delete(waiter)
          resolve(events.since(sinceSeq))
        }
        const timer = setTimeout(() => {
          eventWaiters.delete(waiter)
          resolve(events.since(sinceSeq))
        }, timeoutMs)
        eventWaiters.add(waiter)
      })
    },

    markCommandDone(id) {
      queue.markDone(id)
    },

    reset() {
      queue.clear()
      events.clear()
      clients.clear()
    },

    /** 服务端关闭/测试结束时调用：释放所有挂着的等待位，别让进程干等。 */
    dispose() {
      for (const deliver of [...commandWaiters.values()]) deliver(null)
      commandWaiters.clear()
      wakeEventWaiters()
    },
  }
}
