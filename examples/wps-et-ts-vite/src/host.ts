/**
 * 与 WPS 宿主交互的唯一入口。
 *
 * 整个示例只有这个文件认识 `Application`，其余都是纯逻辑：
 * 测试时只需要给这一层一个替身，换 WPS 版本 / 换 API 风格时也只改这里。
 * 这里用的是 WPS 表格（ET）的 Excel 兼容对象模型。
 */

export interface HostResult {
  ok: boolean
  reason: string
}

/** 写入目标：A1。 */
const TARGET_CELL = "A1"

export function insertHello(text: string): HostResult {
  const sheet = window.Application?.ActiveWorkbook?.ActiveSheet
  if (!sheet) {
    return { ok: false, reason: "当前没有打开的工作簿" }
  }
  sheet.Range(TARGET_CELL).Value2 = text
  return { ok: true, reason: "" }
}

/** 读回单元格，用来确认真的写进去了（测试与调试都用它）。 */
export function readCell(): string {
  const sheet = window.Application?.ActiveWorkbook?.ActiveSheet
  return sheet ? String(sheet.Range(TARGET_CELL).Value2 ?? "") : ""
}
