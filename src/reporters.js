/**
 * Reporter：把“这次跑得怎么样”从命令行参数里解耦出来。
 *
 *   regex（默认）  在页面输出里找 `tests=N passed=N failed=N`，失败项决定退出码；
 *   json           除了同样的判定，再输出一份机器可读的汇总（CI / 看板用）；
 *   模块路径       自己实现，导出 default 函数返回 { onLog, report, finish }。
 *
 * 想换成别的报告格式（比如把结果写进 JUnit XML）时，不用改桥本身 ——
 * 这也是 vitest / jest / playwright 把 reporter 做成插件的原因。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { DEFAULT_REPORT_PATTERN, matchReport } from "./protocol.js"

/** JSON reporter 最多带多少条页面日志（避免把整个运行日志塞进 JSON）。 */
const JSON_LOG_LIMIT = 2_000

const KNOWN_KINDS = new Set(["regex", "json"])

/**
 * @param {object} [options]
 * @param {string} [options.kind] `regex` | `json` | 自定义模块路径
 * @param {string} [options.pattern] regex 用的正则源码
 * @param {string} [options.outFile] 输出文件（默认 stdout）
 * @param {string} [options.cwd] 解析自定义模块路径的基准目录
 */
export async function createReporter(options = {}) {
  const kind = options.kind || "regex"
  if (KNOWN_KINDS.has(kind)) return createBuiltinReporter(kind, options)

  const modulePath = path.resolve(options.cwd ?? process.cwd(), kind)
  const module = await import(pathToFileURL(modulePath).href)
  const factory = module.default ?? module.createReporter
  if (typeof factory !== "function") {
    throw new Error(`自定义 reporter 需要导出 default 函数：${modulePath}`)
  }
  const reporter = await factory({ pattern: options.pattern ?? DEFAULT_REPORT_PATTERN })
  return normalizeReporter(reporter, modulePath)
}

function createBuiltinReporter(kind, options) {
  const pattern = options.pattern ?? DEFAULT_REPORT_PATTERN
  let report = null
  const logs = []

  const reporter = {
    get report() {
      return report
    },

    onLog(event) {
      if (kind === "json") {
        if (logs.length < JSON_LOG_LIMIT) logs.push({ seq: event.seq, level: event.level, text: event.text })
      }
      if (!report) report = matchReport(event.text, pattern)
    },

    async finish(summary) {
      if (kind !== "json") return
      const payload = {
        ok: summary.exitCode === 0,
        exitCode: summary.exitCode,
        command: summary.command,
        client: summary.client ?? null,
        durationMs: summary.durationMs,
        report,
        result: summary.result ?? null,
        page: summary.page ?? null,
        logs,
        logsTruncated: logs.length >= JSON_LOG_LIMIT,
      }
      const text = `${JSON.stringify(payload, null, 2)}\n`
      if (!summary.outFile) {
        summary.stdout.write(text)
        return
      }
      const file = path.resolve(summary.outFile)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text, "utf8")
      summary.logger.info(`JSON 报告已写入：${file}`)
    },
  }

  return normalizeReporter(reporter, kind)
}

/** 自定义 reporter 只要求实现自己关心的部分，其余补空实现。 */
function normalizeReporter(reporter, name) {
  if (!reporter || typeof reporter !== "object") {
    throw new Error(`reporter 需要返回对象：${name}`)
  }
  return {
    get report() {
      return typeof reporter.getReport === "function" ? reporter.getReport() : reporter.report ?? null
    },
    onLog: typeof reporter.onLog === "function" ? reporter.onLog.bind(reporter) : () => {},
    finish: typeof reporter.finish === "function" ? reporter.finish.bind(reporter) : async () => {},
  }
}
