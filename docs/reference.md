# 参考手册

写给“已经接上了、想用全”的读者：全部命令与选项、输出契约、安全设置与服务端 API。
想先跑起来，看 [README](../README.md)。

## 目录

- [命令](#命令) · [选项](#选项) · [输出、状态与退出码](#输出状态与退出码)
- [reporter](#reporter) · [端口与 token](#端口与-token) · [安全](#安全)
- [服务端 API](#服务端-api) · [页面侧](#页面侧)

---

## 命令

所有命令都作用在**加载项页面里**，而不是终端进程里 —— 加载项页面是桥的“手”，
由 dev server 注入的 [src/client.js](../src/client.js) 代我们执行。

### `status`

看桥有没有接上页面、每个页面在干什么。给人看的摘要走 stderr，
机器可读的 JSON 走 stdout（见 [输出、状态与退出码](#输出状态与退出码)）。

### `click <控件Id>`

调用页面上的同名回调。WPS 加载项的 Ribbon 交给 `window.OnAction`，
所以 `click btnRunTests` 与“用户点了那个按钮”走的是同一条路径（同一个函数、同一份状态）。

```shell
wps-bridge click btnHello
wps-bridge click btnRefresh --follow 3000     # 入口是 fire-and-forget，多听 3 秒日志
```

`onAction` 这类回调通常是“立刻返回、后台接着干”，所以命令返回不等于活干完了 ——
`--follow <ms>` 就是为它准备的：命令返回后继续收集这段时间的页面日志。

### `call <模块> <函数>`

动态 `import` 该模块并调用指定函数，参数用 `--arg` / `--args` 传。

```shell
wps-bridge call /src/modules/refresh.ts refreshAll
wps-bridge call /src/utils/config.ts getConfig --arg ribbon_theme_mode --arg light
wps-bridge call /src/modules/refresh.ts refreshAll --args '[]'
```

默认拿到的是页面里**同一个模块实例**（能访问运行期状态：缓存、单例、已建立的连接）。
加了 `--fresh` 就会让 dev server 重新编译、页面重新求值 —— 改了文件要跑新代码时用它。

### `run <文件>`

在页面里执行一个模块文件，**支持 TypeScript**（编译交给 dev server，桥只管下发路径）。

```ts
// test/perf.ts
import { runPerformanceTests } from "./index"

export default async function () {
  await runPerformanceTests()
}
```

```shell
wps-bridge run ./test/perf.ts --expect-report
wps-bridge run ./src/modules/refresh.ts --export refreshAll
```

- 文件路径相对**当前工作目录**解析；项目外的文件会改写成 `/@fs/<绝对路径>`，
  若被 vite 的 `server.fs.allow` 拦下，把它加进白名单即可（自写的 dev server 见
  [examples 的做法](../examples/wps-writer-js/dev-server.js)）。
- 不带 `--export` 时依次找 `default`、`main` 导出并调用；两者都不是函数就只执行
  模块副作用，并把导出名列表回报给终端。
- `--fresh` 同上：默认复用页面里的模块实例。

### `eval '<代码>'`

在页面里执行一段代码，可以 `return` 一个值（返回值走 stdout）。

```shell
wps-bridge eval "return Application.Version"
wps-bridge eval "return await importModule('/src/util.ts')"
```

代码里可以用注入的 `importModule(path)` 来动态加载模块（路径规则同 `run`）。

### 传参

`--arg` 可重复，会尝试按 JSON 解释，Windows 下不必操心引号；`--args` 收一个 JSON 数组：

```shell
wps-bridge call /src/a.ts run --arg hello --arg 2 --arg true --arg "[1,2]"
# → run("hello", 2, true, [1, 2])
```

---

## 选项

| 选项 | 说明 |
| --- | --- |
| `--port <n>` | dev server 端口。默认自动发现（读项目里的 `.wps-bridge.json`），读不到才用 5173 |
| `--target <目标>` | 命令发给哪个页面：`newest`（默认，最新且没被卡住的）或 `status` 里的页面 id |
| `--export <名字>` | `run` 要调用的导出名（默认 `default` / `main`） |
| `--fresh` | 让 dev server 重新编译并重新执行这个模块（默认复用页面里的同一实例） |
| `--expect-report` | 等到页面输出报告行为止，并用其中的 `failed=` 决定退出码 |
| `--report-pattern <re>` | 报告行正则，默认 `tests=(\d+) passed=(\d+) failed=(\d+)` |
| `--reporter <名字>` | `regex`（默认）/ `json` / 自定义模块路径，见 [reporter](#reporter) |
| `--out <文件>` | reporter 的输出文件（默认 stdout） |
| `--timeout <ms>` | 单条命令超时，默认 900000 |
| `--follow <ms>` | 命令返回后继续收集日志的时长（默认 0） |
| `--arg <值>` / `--args <json>` | `call` / `run` 的调用参数 |
| `--token <值>` | 桥要求 token 时用（一般会从 `.wps-bridge.json` 自动读到） |
| `--launch` / `--doc <path>` | 等不到页面时自动启动 WPS（可指定打开的文档）；跑完把它关掉 |
| `--keep-wps` | 本次启动的 WPS 保留不关（调试用） |
| `--exe <path>` | 指定 `wps.exe`（也可用环境变量 `WPS_EXE`） |
| `--start <命令>` | 本地没有 dev server 时用它启动，默认 `npm run dev` |
| `--keep-server` | 本次启动的 dev server 保留不关 |
| `--no-hook` | 不启用页面钩子，恢复加载项自身的模态提示 |
| `--quiet` | 只输出错误 |

---

## 输出、状态与退出码

**stdout 只有“页面产生的东西”**：页面日志、命令返回值、`--reporter` 的输出。
**桥自己的诊断一律走 stderr**。所以下面这种用法拿到的是干净的报告：

```shell
wps-bridge run ./test/perf.ts --expect-report > 报告.txt
```

`status` 会把机器可读的 JSON 写到 stdout，每个页面都带一个**推导出来的**状态
（不是页面自报的，而是从两条独立信号推出来的）：

- **信标（beacon）**：页面里的 Web Worker 按 `heartbeatMs`（默认 5 s）上报，
  不受长任务影响 —— 它停了就是页面进程没了；
- **主线程进度**：信标带着主线程最近一次 tick 的时间戳 —— 它不动，说明主线程被占住了。

| state | 含义（推导） | 怎么办 |
| --- | --- | --- |
| `idle` | 信标正常、主线程在推进、空闲 | —— |
| `busy` | 正在执行命令，主线程还在推进 | 等；页面侧执行上限见 `commandTimeoutMs` |
| `stalled` | 信标正常（页面还在），但主线程超过阈值没推进 | 先看 WPS 里有没有弹窗；也可能是长同步任务，等它跑完 |
| `offline` | 信标停了 | 页面多半已关闭或崩溃：重启宿主 / 重新加载加载项 |

超过 `blockedAfterMs`（默认 15 s = 信标间隔的 3 倍，与 Chromium 判定“页面无响应”的
桌面阈值一致）就分开报：信标停了标 `offline`，信标在但主线程不推进标 `stalled`。
`stalled` 只说明“主线程不推进”：长同步任务与宿主弹窗从外面分不出来，桥不替你猜。
超时提示也按这两种情况分开说，而不是只说“超时”。

退出码（也是 `bin/cli.js` 与 `npm script` 的契约）：

| 码 | 含义 |
| --- | --- |
| `0` | 成功；报告里 `failed=0` |
| `1` | 命令失败，或报告里 `failed>0` |
| `2` | 没有页面接入（或页面是旧版客户端，需要重新加载加载项） |
| `3` | 超时 |

---

## reporter

| `--reporter` | 行为 |
| --- | --- |
| `regex`（默认） | 在页面输出里找 `--report-pattern` 匹配的那行，`failed=` 决定退出码 |
| `json` | 同样的判定，另外输出一份机器可读的汇总（CI / 看板用），配 `--out` 写文件 |
| `<模块路径>` | 自己实现，相对 `process.cwd()` 解析 |

`json` 的形状：

```json
{
  "ok": true,
  "exitCode": 0,
  "command": { "kind": "run", "summary": "run /test/perf.ts" },
  "client": "page-1758000000000-ab12cd",
  "durationMs": 1234,
  "report": { "total": 51, "passed": 51, "failed": 0, "line": "…tests=51 passed=51 failed=0" },
  "result": { "ok": true, "value": "…" },
  "page": { "url": "http://127.0.0.1:3889/index.html", "title": "…" },
  "logs": [{ "seq": 3, "level": "log", "text": "ok   用例 1" }],
  "logsTruncated": false
}
```

自定义 reporter 的契约（`onLog` 与 `getReport` 可省）：

```js
// my-reporter.js
export default function createReporter({ pattern }) {
  let report = null
  return {
    onLog(event) {},              // 每条页面日志：{ seq, level, text, commandId }
    getReport: () => report,      // { total, passed, failed, line } | null
    async finish(summary) {},     // { exitCode, command, client, durationMs, report, result, page, outFile, stdout, logger }
  }
}
```

---

## 端口与 token

dev server 启动后会把一行 JSON 写进**项目目录**的 `.wps-bridge.json`：

```json
{ "protocol": 3, "port": 3889, "token": null, "pid": 12345, "startedAt": "2026-09-17T02:00:00.000Z" }
```

终端侧从当前目录**一路往上**找这个文件（和 vite 找 workspace root 一个思路），
于是不用再手工对齐 3889 / 5173。写它的进程退出时会自己收走；记得加进 `.gitignore`。

- 关闭：`createBridgeMiddleware({ portFile: false })` / `wpsDebugBridge({ portFile: false })`
- 自定义位置：`portFile: ".cache/wps-bridge.json"`
- 不想调用 `announce()` 也行：桥会从第一个请求的 `Host` 头里推端口，
  只是终端发现得晚一点。

---

## 安全

桥能执行任意 JS、能读写用户文档，所以默认就把门关小：

- **只接受本机来源**：`Host` 必须是 `localhost` / `127.0.0.0/8` / `::1`；
  带 `Origin` 时（浏览器发跨站请求一定会带）必须与 `Host` 同源。
  这样恶意网页、以及 DNS rebinding 伪装成别的域名打过来的请求都调不动它。
- **可选 token**：再加一层保险。页面由 dev server 注入、终端从端口文件读，两边都是自动的。

```js
wpsDebugBridge({ token: true })             // vite
createBridgeMiddleware({ token: true })     // 其它 dev server
```

确实需要从别的机器访问（远程调试）时，自定义放行规则：

```js
createBridgeMiddleware({
  originGuard: ({ host, origin }) => host.endsWith(":3889") || origin === "http://192.168.1.5:3889",
})
```

> `examples/wps-et-ts-vite` 的 `host: "0.0.0.0"` 只影响**页面**能不能被别的机器打开，
> 桥接口仍然只认本机同源。

---

## 服务端 API

```js
import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"
```

| 导出 | 作用 |
| --- | --- |
| `createBridgeMiddleware(options)` | connect 风格中间件，返回 `{ handle, announce, status, dispose }` |
| `injectBridgeClient(html, options)` | 往 HTML 里注入选项与客户端脚本 |
| `bridgeClientTags(options)` / `bridgeClientOptions(options)` | 自己拼标签/选项时用 |
| `isLoopbackHost(host)` / `defaultOriginGuard(ctx)` / `portFromHost(host)` | 默认的门禁规则，可自行替换 |

`createBridgeMiddleware` 的选项（与 `wpsDebugBridge` 相同）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `readyCheck` | `typeof window.OnAction === 'function'` | 页面就绪判定的 JS 表达式 |
| `readyTimeoutMs` | `90000` | 等页面就绪的上限 |
| `commandTimeoutMs` | `120000` | 单条命令在**页面里**的执行上限 |
| `token` | 关 | `true` 为随机生成，也可给字符串 |
| `originGuard` | 只放本机同源 | `({ host, origin }) => boolean` |
| `portFile` | `.wps-bridge.json` | `false` 关闭 |
| `eventBufferSize` | `5000` | 事件日志容量 |
| `maxQueuedCommands` | `1000` | 命令队列上限（满了明确报错，不无限堆积） |
| `clientTtlMs` | `45000` | 客户端空闲多久算断开 |
| `heartbeatMs` | `5000` | 页面侧信标间隔（由 Web Worker 发送） |
| `blockedAfterMs` | `15000` | 信标/主线程多久没动静算异常（失联 / 无响应） |
| `log` / `quiet` / `logger` | —— | 诊断输出（走 stderr） |

个别项目需要更灵敏（或更迟钝）的状态判别时，在项目侧覆盖这两个参数就行，
不要为个例改动桥的默认值：`blockedAfterMs` 按 `heartbeatMs` 的 **3 倍**跟调
（默认 5000 / 15000 就是这个比例，容忍漏两拍），比例压得太紧会把长同步任务
误报成 `stalled`。

类型声明随包提供（`src/server.d.ts`、`src/vite-plugin.d.ts`）。

---

## 页面侧

注入到加载项页面的客户端会挂两个全局对象：

```js
window.__wpsDebugBridgeOptions   // dev server 注入的配置：readyCheck / commandTimeoutMs / heartbeatMs / token…
window.__wpsDebugBridge          // 运行时句柄：{ clientId, protocol, notify(text) }
```

`notify(text)` 就是 [README 里那个钩子](../README.md#4可选把模态提示交给桥)：
把提示变成一条回传终端的日志，避免 `alert` 冻住页面。

页面侧脚本本身是纯 ESM、零依赖（[src/client.js](../src/client.js)），
要搬到别的 dev server 上时，把 `client.js` + `protocol.js` 按
`/__wps_debug_bridge/assets/` 提供出来、并往 HTML 注入 `<script type="module" src="…/client.js">` 即可。
