/**
 * 与 WPS 宿主交互的唯一入口。
 *
 * 整个示例只有这个文件认识 `Application`，其余都是纯逻辑。
 * 好处有两个：
 *   1. 测试时只需要给这一层一个替身（见 test/hello.test.js 与被模拟的宿主）；
 *   2. 换 WPS 版本 / 换 API 风格时只改这里，桥的用法、Ribbon、测试写法都不用动。
 *
 * 这里用的是 WPS 文字（Writer）的 Word 兼容对象模型。
 */

/** @returns {{ ok: boolean, reason: string }} */
function insertHelloWorld(text) {
  const doc = window.Application.ActiveDocument
  if (!doc) {
    return { ok: false, reason: "当前没有打开的文档" }
  }
  doc.Content.Text = text
  return { ok: true, reason: "" }
}

/** 读回正文，用来确认真的写进去了（测试与调试都用它）。 */
function readDocumentText() {
  const doc = window.Application.ActiveDocument
  return doc ? String(doc.Content.Text ?? "") : ""
}
