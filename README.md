# wps-js-addin-debug-bridge

WPS JS 加载项的**开发期调试桥**：让终端（脚本、CI、AI Agent）能够

- **触发页面上的入口** —— `wps-bridge click btnRunTests`，等价于“替用户点一下 Ribbon 按钮”；
- **在运行中的加载项里执行代码** —— `run ./test/perf.ts`（支持 TypeScript）、
  `call <模块> <函数>`、`eval "return Application.Version"`；
- **实时收到页面里的 console 输出**，并按测试报告行决定退出码。

它**不改加载项源码**：页面侧脚本由 dev server 注入，只在开发模式存在，生产构建里没有它的痕迹。

<details>
<summary>为什么不用 COM、CEF 远程调试或 UI 自动化？（展开看原因）</summary>

给 WPS 加载项做自动化测试时，常见的几条路都走不通：

- **COM（`KWPS.Application`）**：能做文档操作，但自定义 Ribbon 按钮不出现在
  `Application.CommandBars` 里，`Application.Run` 只认宏，点不到插件按钮。
- **CEF 远程调试**：宿主自己拉起 Chromium 内核。`/JsApiremotedebuggingport=<port>`
  （`kshell.dll` 的 `KxStartup::getJsApiRemoteDebuggingPort`，即官方 `wpsjs -r` 用的开关）
  实测在加载项页面上开不出端口：页面由 `wpscloudsvr.exe` 拉起的 `jsapibrowser.dll`
  宿主承载，开关到不了那个进程。
- **业务系统集成**（`wpsjsrpcsdk.js` → `127.0.0.1:58890/transfer/runParams`）：
  能静默启动 WPS 并调用加载项里注册的函数，但需要启用该本地服务，
  且加载项必须注册可被调用的函数，侵入较大。
- **UI 自动化**：依赖人工点击，无法无人值守。

但开发模式下的加载项页面**是我们本机的 dev server 下发的**。既然页面是自己发出去的，
就可以往里注入一小段脚本，由它代我们在加载项页面内执行触发与调用 —— 这就是本包做的事。

</details>

## 快速开始

### 1. 安装

```shell
npm i -D github:jiaojiaodubai/wps-js-addin-debug-bridge
```

要求 Node 18+；页面侧零依赖（会被注入加载项页面，不引任何三方包）。

### 2. 接进 dev server

**vite**：加一个插件就行。

```js
// vite.config.js
import { defineConfig } from "vite"
import { wpsDebugBridge } from "wps-js-addin-debug-bridge"

export default defineConfig({
  plugins: [
    wpsDebugBridge(), // 只在 `vite dev` 生效；生产构建不会包含任何桥代码
  ],
})
```

**其它 dev server**（webpack / esbuild / 自写的静态服务……）：桥的服务端是一个
connect 风格的中间件，挂上去、下发 HTML 时注入客户端即可。

```js
import { createServer } from "node:http"
import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"

const bridge = createBridgeMiddleware()

createServer((request, response) => {
  bridge.handle(request, response, async () => {
    response.end(injectBridgeClient(html)) // 下发 HTML 时注入页面侧客户端
  })
}).listen(3889, () => bridge.announce(3889)) // 顺手把端口写进 .wps-bridge.json
```

“页面就绪”的默认判定是 `typeof window.OnAction === 'function'`（等 Ribbon 回调挂到 window 上）；
页面结构不一样时，用 `readyCheck` 换成你自己的表达式。

三种技术栈的**完整示例**见 [`examples/`](examples/)：

| 示例 | 组件 | 技术栈 | 桥怎么接 |
| --- | --- | --- | --- |
| [`wps-writer-js`](examples/wps-writer-js) | WPS 文字 | 纯 JS（无打包器） | 自写静态 dev server + `createBridgeMiddleware()` |
| [`wps-et-ts-vite`](examples/wps-et-ts-vite) | WPS 表格 | TypeScript + Vite | 插件 `wpsDebugBridge()` |
| [`wps-wpp-ts-esbuild`](examples/wps-wpp-ts-esbuild) | WPS 演示 | TypeScript + esbuild | esbuild 按需打包 + `createBridgeMiddleware()` |

### 3. 在终端里下命令

```shell
npx wps-bridge status                    # 页面接上了吗（端口自动发现）
npx wps-bridge click btnRunTests         # 触发 Ribbon 控件
npx wps-bridge run ./test/perf.ts --expect-report
npx wps-bridge eval "return Application.Version"
```

写进 `package.json` 就能进 CI（`--expect-report` 会用报告行里的 `failed=` 决定退出码）：

```json
{
  "scripts": {
    "test:wps": "wps-bridge click btnRunTests --expect-report"
  }
}
```

### 4.（可选）把模态提示交给桥

宿主里的 `alert` 会**冻结**加载项页面，之后桥的命令再也送不进去
（实测 `window.alert` 在加载项页面里不可赋值、不可 `defineProperty`）。
桥在页面里挂了一个钩子，加载项可以**选择**把非阻塞提示交给它：

```js
// 加载项代码里，例如测试入口的汇总提示
const bridge = window.__wpsDebugBridge

if (bridge?.notify) {
  bridge.notify("测试完成：51 通过，0 失败")
}
else {
  alert("测试完成：51 通过，0 失败")
}
```

不接这个钩子也能用：只是弹窗出现时页面会冻住，需要人工关掉。

## 命令速查

下面这些命令都作用在**加载项页面里**，不是在终端进程里：`click` 走页面上的 Ribbon 回调，
`call` / `run` 走页面自己的模块系统 —— 所以拿到的是运行中的那份状态（缓存、单例都在）。

| 命令 | 作用 |
| --- | --- |
| `status` | 看桥与页面的连接状态（每个页面是空闲、在跑、还是被卡住） |
| `click <控件Id>` | 调用页面里同名回调（WPS 加载项即 `window.OnAction`） |
| `call <模块> <函数>` | 动态 import 该模块并调用函数，参数用 `--arg` / `--args` 传 |
| `run <文件>` | 在页面里执行一个模块文件（支持 `.ts`，由 dev server 编译） |
| `eval '<代码>'` | 在页面里执行代码，可以 `return` 一个值 |

```shell
wps-bridge call /src/utils/config.ts getConfig --arg ribbon_theme_mode --arg light
wps-bridge run ./test/perf.ts --expect-report          # 等报告行，按 failed= 定退出码
wps-bridge run ./src/modules/refresh.ts --export refreshAll
```

完整的选项、输出契约与安全说明见 **[docs/reference.md](docs/reference.md)**。

## 已知限制

- 只对**开发模式**生效，发布构建里没有任何桥代码。
- 页面必须由带桥的 dev server 提供；改了桥的代码后要重启 dev server，
  并让宿主重新加载加载项页面（`wps-bridge status` 可确认是否已接入）。
- 宿主弹窗会冻结页面：`status` 会把这种页面标成 `blocked`，先关掉弹窗即可恢复。
- WPS 通常单实例运行：`--launch` 会复用已打开的实例，页面列表里可能同时存在多个历史连接；
  命令默认只发给**最新且没被卡住**的那个页面。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/reference.md](docs/reference.md) | 全部命令与选项、输出/状态/退出码、端口与安全、服务端 API |
| [docs/development.md](docs/development.md) | 工作原理、目录结构、怎么跑测试、代码约定 |
| [examples/README.md](examples/README.md) | 三个接入示例的跑法与差异 |

## 许可

[MIT](LICENSE) © jiaojiaodubai
