# WPS 表格 · Hello World（TypeScript + Vite）

Ribbon 上两个按钮：一个把 `Hello World` 写进 `A1`，一个在加载项页面里跑测试。
页面与测试都是 TypeScript，由 vite（esbuild）负责编译。

这个示例演示：**在 vite 项目里接入桥只需要一个插件**。

## 目录

```text
manifest.xml       加载项元数据
ribbon.xml         Ribbon 自定义 UI
index.html         加载项页面入口（由 vite 下发，桥注入客户端）
src/main.ts        入口：把 Ribbon 回调挂到 window
src/ribbon.ts      Ribbon 回调（OnAddinLoad / OnAction / OnGetEnabled）
src/hello.ts       纯逻辑：问候语与提示文案
src/host.ts        唯一与 WPS 宿主打交道的地方（Application.ActiveWorkbook）
src/util.ts        notify（接桥的提示钩子）/ getUrlPath
src/globals.d.ts   WPS 注入的全局对象的类型声明
test/mini-test.js  极简测试框架（输出桥能识别的报告行）
test/hello.test.ts 测试模块（终端与页面里跑的是同一份）
vite.config.ts     vite 配置：桥插件 + 端口 + 发布时拷贝 manifest/ribbon
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

`--port` 只在需要时写：dev server 会把实际端口写进项目目录的 `.wps-bridge.json`
（记得加进 `.gitignore`），终端侧自动读。

## 桥是怎么接进来的

`vite.config.ts` 里加一个插件就完事：

```ts
import { wpsDebugBridge } from "wps-js-addin-debug-bridge"

export default defineConfig({
  plugins: [
    wpsDebugBridge(), // 只作用于 `vite dev`：注入客户端、提供 /__wps_debug_bridge 接口
  ],
})
```

- 插件是 `apply: "serve"`，**生产构建里不会包含任何桥代码**；
- 默认的页面就绪判定是 `typeof window.OnAction === 'function'`，即
  “等 `src/main.ts` 把 Ribbon 回调挂到 window 上”；
- 如果页面由别的路径提供（例如 `base` 不是 `/`），用 `readyCheck` 换判定条件即可。

## 测试模块

`test/hello.test.ts` 用 `test/mini-test.js` 断言，最后打出一行报告：

```text
WPS 表格 · TS + Vite Hello World: tests=5 passed=5 failed=0
```

桥的 `--expect-report` 默认就找这一行，`failed=0` 才算通过。
`run` 支持 `.ts`：页面里的动态 import 由 dev server 编译，桥只管下发路径。

想换成 vitest / jest 也行 —— 只要最终往 console 打出同样一行报告。

## 发布

```shell
npm run build          # 产出 dist/（含 index.html、资源，以及拷贝过去的 manifest.xml / ribbon.xml）
```

`dist/` 就是可以直接部署（或被 `wpsjs publish` 收录）的加载项目录。
