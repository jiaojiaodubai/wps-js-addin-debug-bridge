# 示例：把调试桥接进 WPS 加载项

三个最小可跑的 Hello World 加载项，分别覆盖**三个组件**与**三种技术栈**，
用来说明不同项目该怎么接入 [`wps-js-addin-debug-bridge`](../README.md)。

| 示例 | 组件 | 技术栈 | 桥怎么接 |
| --- | --- | --- | --- |
| [`wps-writer-js`](./wps-writer-js) | WPS 文字 | 纯 JS（无打包器） | 自己写的静态 dev server + `createBridgeMiddleware()` |
| [`wps-et-ts-vite`](./wps-et-ts-vite) | WPS 表格 | TypeScript + Vite | vite 插件 `wpsDebugBridge()` |
| [`wps-wpp-ts-esbuild`](./wps-wpp-ts-esbuild) | WPS 演示 | TypeScript + esbuild | esbuild 按需打包 + `createBridgeMiddleware()` |

三个示例的共同点：

- 只做两件事：Ribbon 上「写入 Hello World」与「在加载项里跑测试」；
- **加载项源码里没有任何桥的代码** —— 客户端是 dev server 注入的，生产构建里不存在；
- 都自带一个测试模块（`test/hello.test.*`），终端与页面里跑的是同一份代码；
- 都用「纯逻辑 / 宿主访问」分层：只有 `host.*` 认识 `Application`，其余都可以直接断言。

## 每个示例怎么跑

```shell
cd wps-writer-js          # 或 wps-et-ts-vite / wps-wpp-ts-esbuild
npm install

npm run dev               # 终端 A：起 dev server（默认 3889，与官方 wpsjs 模板一致）
npx wps-bridge status                    # 终端 B：确认加载项页面接上了（端口自动发现）
npx wps-bridge click btnHello            # 等价于点一下 Ribbon 按钮
npm run test:wps                         # 跑测试模块，按 failed= 决定退出码
```

`npm run test:wps` 都带了 `--start "npm run dev"`：本地没有 dev server 时桥会自己拉一个，
跑完再关掉 —— 所以只跑这一条命令也行。

> 示例的 `package.json` 里把桥写成 `"wps-js-addin-debug-bridge": "file:../.."`，
> 是为了在**这个仓库里**直接跑；把示例拷到别处时换成
> `"github:jiaojiaodubai/wps-js-addin-debug-bridge"` 即可。

WPS 里如果还没加载过开发版加载项，先重启 WPS 让宿主重新拉取 `index.html`
（用 `wpsjs debug` 或手动装一次都可以）。

## 关于 API 与宿主替身

示例里的文档写入用的是 WPS 的 Word / Excel / PowerPoint 兼容对象模型
（`ActiveDocument` / `ActiveWorkbook` / `ActivePresentation`），
并且都收在各自 `host.*` 这一个文件里。如果你的 WPS 版本写法不同，改那一个文件即可 ——
Ribbon、测试、桥的用法都不受影响。

仓库自己的测试（`test/examples.test.js`）就是这么干的：它把这三个示例真的跑起来，
用一个“WPS 宿主替身”替换 `Application`，于是**不需要安装 WPS**也能验证：
Ribbon 入口能点、测试模块能跑、报告行能被桥解析。

## 三个示例的差异

- **纯 JS**：`index.html` 直接用 `<script>` 加载，顶层 `function` 就是全局函数，
  `ribbon.xml` 的 `onAction="OnAction"` 能直接找到它。零依赖，改完刷新页面即可。
- **TS + Vite**：模块里的函数不是全局的，要在 `src/main.ts` 里 `Object.assign(window, …)`
  显式挂一次。好处是 HMR、TS 类型、`.ts` 测试模块都开箱即用。
- **TS + esbuild**：用 esbuild 的 `bundle`（而不是 `transform`）按需编译请求到的 `.ts`，
  这样 `./ribbon` 这种不带扩展名的 import 也能正确落到浏览器上。
