# WPS 演示 · Hello World（TypeScript + esbuild）

Ribbon 上两个按钮：一个把 `Hello World` 写到第 1 页的标题，一个在加载项页面里跑测试。
页面与测试都是 TypeScript，由 esbuild 编译。

这个示例演示：**在非 vite 的打包器/开发服务器里接入桥**。
esbuild 只负责把 TS 变成浏览器能跑的 ESM，页面由 `dev-server.js`（几十行 Node）发出，
桥通过 `wps-js-addin-debug-bridge/server` 的 `createBridgeMiddleware()` 挂上。

## 目录

```text
manifest.xml       加载项元数据
ribbon.xml         Ribbon 自定义 UI
index.html         加载项页面入口
src/main.ts        入口：把 Ribbon 回调挂到 window
src/ribbon.ts      Ribbon 回调（OnAddinLoad / OnAction / OnGetEnabled）
src/hello.ts       纯逻辑：问候语与提示文案
src/host.ts        唯一与 WPS 宿主打交道的地方（Application.ActivePresentation）
src/util.ts        notify（接桥的提示钩子）/ getUrlPath
src/globals.d.ts   WPS 注入的全局对象的类型声明
dev-server.js      开发服务器：esbuild 按需打包 + 桥中间件
build.js           发布构建：打包 + 拷贝静态文件
test/mini-test.js  极简测试框架（输出桥能识别的报告行）
test/hello.test.ts 测试模块（终端与页面里跑的是同一份）
```

## 跑起来

```shell
npm install

# 终端 A
npm run dev            # http://127.0.0.1:3889

# 终端 B（端口会自动从 .wps-bridge.json 读到，不用写 --port）
npx wps-bridge status
npx wps-bridge click btnHello
npm run test:wps
```

## 桥是怎么接进来的

只有两处，全在 `dev-server.js`：

```js
import { createBridgeMiddleware, injectBridgeClient } from "wps-js-addin-debug-bridge/server"

const bridge = createBridgeMiddleware({
  readyCheck: "typeof window.OnAction === 'function'", // 等 Ribbon 回调挂上再算接入
})

const server = createServer((request, response) => {
  // ① 非 /__wps_debug_bridge 的请求会走 next()，交给后面的静态/编译逻辑
  bridge.handle(request, response, async () => {
    // … .ts 交给 esbuild 按需打包 …
    // ② 下发 HTML 时注入页面侧客户端
    response.end(injectBridgeClient(html))
  })
})
```

打包器的选择与桥无关：webpack / rollup / rspack 同理 —— 能发页面，就能挂这个中间件
（vite 用户更省事，直接 `wpsDebugBridge()` 插件，见 `examples/wps-et-ts-vite`）。

## 测试模块

`test/hello.test.ts` 用 `test/mini-test.js` 断言，最后打出一行报告：

```text
WPS 演示 · TS + esbuild Hello World: tests=5 passed=5 failed=0
```

桥的 `--expect-report` 默认就找这一行，`failed=0` 才算通过。
`run` 支持 `.ts`：页面里的动态 import 由 dev server 编译，桥只管下发路径。

## 发布

```shell
npm run build          # 产出 dist/（js/main.js + index.html + manifest.xml + ribbon.xml）
```

`dist/` 就是可以直接部署（或被 `wpsjs publish` 收录）的加载项目录。
