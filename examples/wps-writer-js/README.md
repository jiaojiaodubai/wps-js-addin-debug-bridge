# WPS 文字 · Hello World（纯 JS，无打包器）

最小的 WPS 加载项：Ribbon 上两个按钮，一个把 `Hello World` 写进当前文档，
一个在加载项页面里跑测试。**不使用任何打包器**，页面就是普通的 `<script>`。

这个示例演示：**桥不绑定 vite**。开发服务器是 `dev-server.js`（零依赖，只用 Node 内置模块），
桥通过 `wps-js-addin-debug-bridge/server` 的 `createBridgeMiddleware()` 挂上去。

## 目录

```text
manifest.xml      加载项元数据（名字、类型）
ribbon.xml        Ribbon 自定义 UI：按钮与回调名
index.html        加载项页面入口（WPS 启动加载项时加载它）
js/util.js        页面工具：GetUrlPath / notify（接桥的提示钩子）
js/hello.js       纯逻辑：问候语与提示文案
js/host.js        唯一与 WPS 宿主打交道的地方（Application.ActiveDocument）
js/ribbon.js      Ribbon 回调：OnAddinLoad / OnAction
dev-server.js     开发服务器：静态文件 + 桥中间件
test/mini-test.js 极简测试框架（输出桥能识别的报告行）
test/hello.test.js 测试模块（终端与页面里跑的是同一份）
```

## 跑起来

```shell
npm install            # 只装桥（file:../..）

# 终端 A：起 dev server（默认 3889，与官方 wpsjs 模板一致）
npm run dev

# 终端 B：确认加载项页面接上了桥（端口从 .wps-bridge.json 自动读）
npx wps-bridge status

# 终端 B：等价于“点一下 Ribbon 上的「写入 Hello World」”
npx wps-bridge click btnHello

# 终端 B：跑测试模块，并按报告行里的 failed= 决定退出码
npm run test:wps
```

`npm run test:wps` 里带了 `--start "npm run dev"`：本地没有 dev server 时桥会自己拉一个，
结束后再关掉 —— 所以也可以只跑这一条命令。

**页面必须先接入桥**：WPS 里如果加载项还没重新加载过，先重启 WPS（或删掉再装一次加载项），
让宿主重新拉取 `index.html`。`status` 会告诉你有没有页面连上来（还会说页面是空闲、
正在跑、还是被弹窗卡住了）。

> dev server 会在项目目录里生成 `.wps-bridge.json`（端口/token/pid），终端侧靠它自动找到桥。
> 它会在 dev server 退出时自己删掉，记得加进 `.gitignore`。

## 桥是怎么接进来的

只有两处，全在 `dev-server.js`：

```js
import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"

const bridge = createBridgeMiddleware({
  readyCheck: "typeof window.OnAction === 'function'", // 等 Ribbon 回调挂上再算接入
})

const server = createServer((request, response) => {
  // ① 非 /__wps_debug_bridge 的请求会走 next()，交给后面的静态文件逻辑
  bridge.handle(request, response, async () => {
    // …
    // ② 下发 HTML 时注入页面侧客户端
    response.end(injectBridgeClient(html))
  })
})
```

加载项源码里**没有任何桥的代码**：桥的客户端是 dev server 注入的，生产构建里不存在。

## 测试模块

`test/hello.test.js` 用 `test/mini-test.js` 断言，最后打出一行报告：

```text
WPS 文字 · 纯 JS Hello World: tests=5 passed=5 failed=0
```

桥的 `--expect-report` 默认就找这一行（`tests=(\d+) passed=(\d+) failed=(\d+)`），
`failed=0` 才算通过。用别的测试框架也行，只要最终往 console 打出同样一行。

两种跑法跑的是同一份代码：

- 终端：`npm run test:wps`
- 页面：Ribbon 上的「在加载项里跑测试」（`js/ribbon.js` 里 `import("/test/hello.test.js")`）

## 关于文档 API

`js/host.js` 用的是 WPS 文字的 Word 兼容对象模型（`ActiveDocument.Content.Text`）。
不同版本/不同 API 风格的写法可能不一样 —— 所以整个示例只有这一个文件认识 `Application`：
真跑起来发现 API 不对，只改这里，Ribbon、测试与桥的用法都不用动。
