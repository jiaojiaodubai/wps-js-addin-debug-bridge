/**
 * WPS 注入到加载项页面里的全局对象。
 *
 * 这里只声明本示例用到的部分。装了官方的类型声明包（如 et-jsapi-declare）之后，
 * 可以把这份文件删掉，换成官方的声明以获得完整的代码提示。
 */
interface Window {
  Application: any
  wps: any
  /** 桥在开发模式下挂的提示钩子；生产构建里没有这个对象。 */
  __wpsDebugBridge?: {
    notify(text: string): void
  }
}
