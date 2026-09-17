/**
 * 与 WPS 宿主交互的唯一入口。
 *
 * 整个示例只有这个文件认识 `Application`，其余都是纯逻辑：
 * 测试时只需要给这一层一个替身，换 WPS 版本 / 换 API 风格时也只改这里。
 * 这里用的是 WPS 演示（WPP）的 PowerPoint 兼容对象模型。
 */

export interface HostResult {
  ok: boolean
  reason: string
}

/** 写入目标：第 1 页的标题占位符。 */
const TARGET_SLIDE = 1

function targetSlide(): any {
  return window.Application?.ActivePresentation?.Slides?.Item(TARGET_SLIDE)
}

export function insertHello(text: string): HostResult {
  if (!window.Application?.ActivePresentation) {
    return { ok: false, reason: "当前没有打开的演示文稿" }
  }
  const slide = targetSlide()
  if (!slide) {
    return { ok: false, reason: "当前演示文稿没有可用的幻灯片" }
  }
  slide.Shapes.Title.TextFrame.TextRange.Text = text
  return { ok: true, reason: "" }
}

/** 读回标题，用来确认真的写进去了（测试与调试都用它）。 */
export function readTitle(): string {
  const slide = targetSlide()
  return slide ? String(slide.Shapes.Title.TextFrame.TextRange.Text ?? "") : ""
}
