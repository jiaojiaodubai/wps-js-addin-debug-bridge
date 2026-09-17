import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createLogger } from "../src/logger.js"
import { DEFAULT_PORT_FILE, DEFAULT_REPORT_PATTERN, describeCommand, matchReport } from "../src/protocol.js"
import {
  DEFAULT_PORT,
  EXIT,
  buildCommand,
  ensureProbeDocument,
  parseArgs,
  pickClient,
  pickUsableClient,
  resolveEndpoint,
  resolveModuleFile,
  stopWps,
  toModuleUrl,
} from "../src/runner.js"

const quiet = createLogger({ quiet: true })

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

test("parseArgs：默认值", () => {
  const options = parseArgs([])
  assert.equal(options.command, "status")
  assert.equal(options.port, 0, "0 表示“还没定”，由端口文件或默认值补上")
  assert.equal(options.expectReport, false)
  assert.equal(options.target, "newest")
  assert.equal(options.reporter, "regex")
  assert.equal(options.quiet, false)
  assert.equal(options.fresh, false)
  assert.deepEqual(options.positionals, [])
})

test("parseArgs：命令与选项", () => {
  const options = parseArgs(["click", "btnRunTests", "--expect-report", "--port", "3889", "--timeout", "1000", "--follow", "3000"])
  assert.equal(options.command, "click")
  assert.deepEqual(options.positionals, ["btnRunTests"])
  assert.equal(options.expectReport, true)
  assert.equal(options.port, 3889)
  assert.equal(options.timeout, 1000)
  assert.equal(options.followMs, 3000)
})

test("parseArgs：新增的选项", () => {
  const options = parseArgs([
    "run", "./test/x.ts",
    "--target", "page-123",
    "--reporter", "json",
    "--out", "report.json",
    "--token", "t0k",
    "--fresh", "--quiet", "--no-hook", "--keep-wps",
    "--doc", "C:/tmp/doc.docx",
  ])
  assert.equal(options.target, "page-123")
  assert.equal(options.reporter, "json")
  assert.equal(options.out, "report.json")
  assert.equal(options.token, "t0k")
  assert.equal(options.fresh, true)
  assert.equal(options.quiet, true)
  assert.equal(options.useHook, false)
  assert.equal(options.keepWps, true)
  assert.equal(options.doc, "C:/tmp/doc.docx")
})

test("parseArgs：未知选项与缺值都要报错", () => {
  assert.throws(() => parseArgs(["--nope"]), /未知选项/)
  assert.throws(() => parseArgs(["--port"]), /需要一个值/)
  assert.throws(() => parseArgs(["--reporter"]), /需要一个值/)
})

test("buildCommand：click / call / eval", () => {
  assert.deepEqual(buildCommand(parseArgs(["click", "btnRefresh"])), { kind: "click", controlId: "btnRefresh" })
  assert.deepEqual(
    buildCommand(parseArgs(["call", "/src/modules/refresh.ts", "refreshAll", "--args", "[]"])),
    { kind: "call", module: "/src/modules/refresh.ts", fn: "refreshAll", args: [] },
  )
  assert.deepEqual(
    buildCommand(parseArgs(["eval", "return 1 + 1"])),
    { kind: "eval", code: "return 1 + 1" },
  )
})

test("buildCommand：缺少参数时报错", () => {
  assert.throws(() => buildCommand(parseArgs(["click"])), /需要控件 Id/)
  assert.throws(() => buildCommand(parseArgs(["call", "/a.ts"])), /需要模块路径与函数名/)
  assert.throws(() => buildCommand(parseArgs(["eval"])), /需要一段 JS 代码/)
  assert.throws(() => buildCommand(parseArgs(["wat"])), /未知命令/)
  assert.throws(() => buildCommand(parseArgs(["call", "/a.ts", "run", "--args", "[oops]"])), /不是合法 JSON/)
})

test("buildCommand：--arg 逐个传参（Windows 下不依赖引号）", () => {
  const command = buildCommand(parseArgs([
    "call", "/a.ts", "run",
    "--arg", "hello",
    "--arg", "2",
    "--arg", "true",
    "--arg", "[1,2]",
  ]))
  assert.deepEqual(command.args, ["hello", 2, true, [1, 2]])
})

test("buildCommand：run 把项目内文件解析成根路径 URL", () => {
  const command = buildCommand(parseArgs(["run", "./src/protocol.js"]))
  assert.equal(command.kind, "run")
  assert.equal(command.file, "/src/protocol.js")
  assert.deepEqual(command.args, [])
})

test("buildCommand：项目外的文件用 /@fs/ URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wps-bridge-"))
  const file = path.join(dir, "outside.ts")
  fs.writeFileSync(file, "export default () => 1\n")
  try {
    const resolved = resolveModuleFile(file)
    assert.match(resolved, /^\/@fs\//)
    assert.ok(resolved.endsWith("/outside.ts"))
    assert.match(toModuleUrl(file), /^\/@fs\//)
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("buildCommand：run 的文件必须存在", () => {
  assert.throws(() => buildCommand(parseArgs(["run", "./nope.ts"])), /找不到文件/)
  assert.throws(() => buildCommand(parseArgs(["run"])), /需要文件路径/)
})

test("buildCommand：run 支持 --export 与 --arg", () => {
  const command = buildCommand(parseArgs(["run", "./src/protocol.js", "--export", "matchReport", "--arg", "x"]))
  assert.equal(command.exportName, "matchReport")
  assert.deepEqual(command.args, ["x"])
})

test("buildCommand：--fresh 才加 cache-busting 参数", () => {
  const plain = buildCommand(parseArgs(["run", "./src/protocol.js"]))
  assert.equal(plain.file, "/src/protocol.js", "默认复用页面里的同一个模块实例")

  const fresh = buildCommand(parseArgs(["run", "./src/protocol.js", "--fresh"]))
  assert.match(fresh.file, /^\/src\/protocol\.js\?t=\d+(\.\d+)?$/)
})

test("pickClient：默认挑最新且信标正常的页面", () => {
  const clients = [
    { id: "page-1", state: "idle" },
    { id: "page-2", state: "idle" },
  ]
  assert.equal(pickClient({ clients }, "newest"), "page-2")
  assert.equal(pickClient({ clients: [] }, "newest"), null)
  assert.equal(pickClient(null, "newest"), null)

  // 主线程无响应 / 已失联的页面要么拖着命令、要么收不到：能避开就避开
  assert.equal(pickClient({ clients: [clients[0], { id: "page-3", state: "stalled" }] }, "newest"), "page-1")
  assert.equal(pickClient({ clients: [clients[0], { id: "page-4", state: "offline" }] }, "newest"), "page-1")
  // 都不行时也得给出一个：让下发流程报真实的失败原因，而不是干等
  assert.equal(pickClient({ clients: [{ id: "page-5", state: "offline" }] }, "newest"), "page-5")

  // 指定了目标就用目标，不在就 null
  assert.equal(pickClient({ clients }, "page-1"), "page-1")
  assert.equal(pickClient({ clients }, "page-9"), null)
})

test("pickUsableClient：只剩失联页面就当没页面（等新的接入）", () => {
  const offline = { id: "page-old", state: "offline", beaconAgeMs: 30_000 }
  const idle = { id: "page-new", state: "idle" }

  // 上一轮收尾后残留的失联登记不能拿来下发命令，也不能拦着 --launch 去启动 WPS
  assert.equal(pickUsableClient({ clients: [offline] }, "newest"), null)
  assert.equal(pickUsableClient({ clients: [offline, idle] }, "newest"), "page-new")
  // 主线程无响应（弹窗/长同步任务）仍然是“页面在”，只是要提醒
  assert.equal(pickUsableClient({ clients: [{ id: "page-stuck", state: "stalled" }] }, "newest"), "page-stuck")
  // 指定了目标就照旧交给下发流程报错，不偷偷换页面
  assert.equal(pickUsableClient({ clients: [offline] }, "page-old"), "page-old")
  assert.equal(pickUsableClient({ clients: [] }, "newest"), null)
})

test("stopWps：把 --launch 拉起的进程关掉", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  await delay(300)
  assert.equal(await stopWps(child, { graceMs: 500 }), true, "进程应当能关掉")
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.equal(await stopWps(child), true, "已经退出的进程再关是幂等的")
  assert.equal(await stopWps(null), true, "没有拉起来过就什么都不用做")
})

test("ensureProbeDocument：探针文档可以反复用", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wps-bridge-probe-"))
  try {
    const file = ensureProbeDocument(dir)
    // .rtf：只可能由 WPS 文字打开，不会弹出“请选择打开文件的方式”
    assert.equal(file, path.join(dir, "probe.rtf"))
    assert.match(fs.readFileSync(file, "utf8"), /^\{\\rtf1/, "探针文档要是 RTF")

    // 第二次调用复用同一份文件：WPS 会把它记进最近文档，内容不该被重写
    fs.writeFileSync(file, "改过了", "utf8")
    assert.equal(ensureProbeDocument(dir), file)
    assert.equal(fs.readFileSync(file, "utf8"), "改过了")
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveEndpoint：优先 --port，其次项目里的 .wps-bridge.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wps-bridge-endpoint-"))
  const nested = path.join(dir, "packages", "addin")
  fs.mkdirSync(nested, { recursive: true })
  await writeFile(path.join(dir, DEFAULT_PORT_FILE), JSON.stringify({
    protocol: 2,
    port: 4321,
    token: "t0k",
    pid: 1,
    startedAt: new Date().toISOString(),
  }), "utf8")

  const cwd = process.cwd()
  try {
    // 从子目录也能找到（往上一层层找）
    process.chdir(nested)
    const found = resolveEndpoint(parseArgs([]), quiet)
    assert.equal(found.port, 4321)
    assert.equal(found.token, "t0k")
    assert.equal(found.source, DEFAULT_PORT_FILE)

    process.chdir(dir)
    const explicit = resolveEndpoint(parseArgs(["--port", "5173"]), quiet)
    assert.equal(explicit.port, 5173)
    assert.equal(explicit.source, "--port")
  }
  finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveEndpoint：没有端口文件时退回默认端口", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wps-bridge-endpoint-"))
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    const endpoint = resolveEndpoint(parseArgs([]), quiet)
    assert.equal(endpoint.port, DEFAULT_PORT)
    assert.equal(endpoint.source, "默认值")
  }
  finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
})

test("退出码是稳定契约（README 与 CI 都按它来）", () => {
  assert.deepEqual(EXIT, { ok: 0, failed: 1, noClient: 2, timeout: 3 })
})

test("matchReport：匹配报告行并取出计数", () => {
  const report = matchReport(`noise\ntests=51 passed=51 failed=0 metrics=121 total=153.654 s\n`)
  assert.deepEqual(report, {
    total: 51,
    passed: 51,
    failed: 0,
    line: "tests=51 passed=51 failed=0 metrics=121 total=153.654 s",
  })
})

test("matchReport：多行文本与自定义正则", () => {
  assert.equal(matchReport("没有任何计数行"), null)
  const custom = matchReport("结果 3 项，失败 2 项", "结果 (\\d+) 项，失败 (\\d+) 项")
  assert.equal(custom.failed, 2)
  assert.equal(custom.total, 3)
  assert.match(DEFAULT_REPORT_PATTERN, /failed/)
})

test("describeCommand：用于日志的摘要", () => {
  assert.equal(describeCommand({ kind: "click", controlId: "btnRefresh" }), "click btnRefresh")
  assert.equal(describeCommand({ kind: "call", module: "/a.ts", fn: "run" }), "call /a.ts#run")
  assert.equal(describeCommand({ kind: "run", file: "/t/perf.ts" }), "run /t/perf.ts")
  assert.match(describeCommand({ kind: "eval", code: "return 1" }), /^eval return 1$/)
})
