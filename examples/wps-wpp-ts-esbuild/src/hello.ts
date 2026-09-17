/**
 * 纯逻辑：不碰宿主，因此可以在任何环境里断言（终端、加载项页面、Node 测试）。
 * 把“能测的”和“必须碰宿主的”分开，是让加载项可测的关键。
 */

const HELLO_TEXT = "Hello World"

export function buildHelloText(): string {
  return HELLO_TEXT
}

/** 第 count 次写入时给用户看的提示文案。 */
export function buildNotice(count: number): string {
  return `已把「${HELLO_TEXT}」写到第 1 页标题（第 ${count} 次）`
}
