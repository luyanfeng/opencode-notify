#!/usr/bin/env bun
/**
 * 流式 ntfy 命令通道冒烟测试（不依赖真实 ntfy）
 *
 * 用 node:http 起一个 mock ntfy，验证 NtfyStreamProvider 的关键语义：
 *   1. 收消息 + 断线重连带 since 补消息 + id 去重
 *   2. 游标失效（HTTP 400）→ 重置游标后重连（不整段重放）
 *   3. 看门狗：长时间无流数据 → 判定连接已死并重连
 *   4. 认证失败熔断：401 达上限后永久停止
 *   5. 合并单话题：带 bot_tag 的自身消息被忽略、他人消息照常投递
 *
 * 运行：bun scripts/control-stream-smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { NtfyStreamProvider, type NtfyStreamProviderOptions } from "../control/ntfy-stream.js"
import { configureLog } from "../log.js"
import type { RawCommandMessage } from "../control/types.js"

configureLog("off") // 冒烟测试不落盘日志

// ── 断言与工具 ──────────────────────────────────────────────────────────────

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`)
  } else {
    failures++
    console.log(`  ❌ ${label}`)
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface MockStream {
  res: Response
  send: (obj: unknown) => void
  close: () => void
}
/** 构造一个可逐条推送 NDJSON 的流式响应 */
function ndjsonStream(): MockStream {
  const enc = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  return {
    res: new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }),
    send: (obj) => { try { ctrl.enqueue(enc.encode(JSON.stringify(obj) + "\n")) } catch { /* closed */ } },
    close: () => { try { ctrl.close() } catch { /* already closed */ } },
  }
}

interface RequestCtx { since: string | null; poll: boolean }
type Behavior = (ctx: RequestCtx) => Response

/** 起一个 mock ntfy，记录每次请求的 since/poll，响应行为由 behavior 决定 */
function startMock(behavior: Behavior) {
  const requests: RequestCtx[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const ctx: RequestCtx = { since: url.searchParams.get("since"), poll: url.searchParams.get("poll") === "1" }
    requests.push(ctx)
    void respond(res, behavior(ctx))
  })
  server.listen(0, "127.0.0.1")
  const ready = new Promise<void>((resolve) => server.once("listening", () => resolve()))
  return {
    server,
    requests,
    ready,
    base: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => server.close(),
  }
}

/** 把 behavior 返回的 Response 流式写回 node 响应 */
async function respond(res: ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((v, k) => res.setHeader(k, v))
  res.writeHead(response.status)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } finally {
    res.end()
  }
}

function newProvider(base: string, opts: NtfyStreamProviderOptions = {}) {
  return new NtfyStreamProvider(base, "cmd-topic", "notify-topic", "tk_test", 2, opts)
}

function collect() {
  const got: RawCommandMessage[] = []
  return { got, onMessage: (m: RawCommandMessage) => { got.push(m) } }
}

// ── 场景 1：收消息 + 断线重连补消息 + 去重 ──────────────────────────────────

async function scenarioReconnectAndDedup() {
  console.log("\n▶ 场景 1：收消息 / 断线重连带 since / id 去重")
  const mock = startMock(({ since }) => {
    const s = ndjsonStream()
    s.send({ id: `open-${mock.requests.length}`, event: "open", topic: "cmd-topic" })
    if (since === null) {
      s.send({ id: "m1", event: "message", topic: "cmd-topic", message: "approve oc-abcd-123456" })
      setTimeout(() => s.close(), 150)
    } else {
      // 重连：since=m1，服务端补发（含重复 m1 用于验证客户端去重）+ m2
      s.send({ id: "m1", event: "message", topic: "cmd-topic", message: "approve oc-abcd-123456" })
      s.send({ id: "m2", event: "message", topic: "cmd-topic", message: "deny oc-abcd-123456" })
    }
    return s.res
  })
  await mock.ready

  const { got, onMessage } = collect()
  const p = newProvider(mock.base(), { keepaliveTimeoutMs: 5000 })
  p.start(0, onMessage)
  await sleep(1800)
  p.stop()
  mock.stop()

  assert(got.length === 2, `收到 2 条消息（实际 ${got.length}: ${got.map((m) => m.id).join(",")}）`)
  assert(got[0]?.id === "m1" && got[1]?.id === "m2", "顺序为 m1,m2")
  assert(mock.requests.length >= 2, `发生重连（连接数 ${mock.requests.length}）`)
  assert(mock.requests[0]?.since === null, "首次连接不带 since")
  assert(mock.requests[1]?.since === "m1", `重连 since=m1（实际 ${mock.requests[1]?.since}）`)
  assert(got.filter((m) => m.id === "m1").length === 1, "重复的 m1 被去重")
}

// ── 场景 2：游标失效（400）→ 重置游标重连 ───────────────────────────────────

async function scenarioInvalidSince() {
  console.log("\n▶ 场景 2：游标失效(HTTP 400) → 重置游标重连")
  let firstServed = false
  const mock = startMock(({ since }) => {
    if (since === "bad") return new Response("invalid since", { status: 400 })
    const s = ndjsonStream()
    s.send({ id: `open-${mock.requests.length}`, event: "open", topic: "cmd-topic" })
    if (!firstServed) {
      // 首次连接：给出一个将被缓存逐出的游标 bad，然后关闭
      firstServed = true
      s.send({ id: "bad", event: "message", topic: "cmd-topic", message: "status" })
      setTimeout(() => s.close(), 150)
    } else {
      // 重置游标后（since=null）应只收新消息 good
      s.send({ id: "good", event: "message", topic: "cmd-topic", message: "status" })
    }
    return s.res
  })
  await mock.ready

  const { got, onMessage } = collect()
  const p = newProvider(mock.base(), { keepaliveTimeoutMs: 5000 })
  p.start(0, onMessage)
  await sleep(2800)
  p.stop()
  mock.stop()

  const sines = mock.requests.map((r) => r.since)
  assert(got.map((m) => m.id).join(",") === "bad,good", `收到 bad,good（实际 ${got.map((m) => m.id).join(",")}）`)
  assert(sines[0] === null, "首次不带 since")
  assert(sines.includes("bad"), "失效游标 bad 被用于重连")
  assert(sines[sines.length - 1] === null, `失效后重置为不带 since 重连（实际末次 ${sines[sines.length - 1]}）`)
}

// ── 场景 3：看门狗（无流数据 → 重连） ───────────────────────────────────────

async function scenarioWatchdog() {
  console.log("\n▶ 场景 3：看门狗（300ms 无数据 → 判定死连接并重连）")
  const mock = startMock(() => {
    const s = ndjsonStream()
    s.send({ id: "open", event: "open", topic: "cmd-topic" })
    // 之后不再推送任何数据，也不关闭 —— 模拟死连接
    return s.res
  })
  await mock.ready

  const { onMessage } = collect()
  const p = newProvider(mock.base(), { keepaliveTimeoutMs: 300 })
  p.start(0, onMessage)
  await sleep(1700)
  p.stop()
  mock.stop()

  assert(mock.requests.length >= 2, `看门狗触发后重连（连接数 ${mock.requests.length}）`)
}

// ── 场景 4：认证失败熔断 ────────────────────────────────────────────────────

async function scenarioAuthBreaker() {
  console.log("\n▶ 场景 4：认证失败(401) 达上限 → 永久停止")
  const mock = startMock(() => new Response("unauthorized", { status: 401 }))
  await mock.ready

  const { onMessage } = collect()
  const p = newProvider(mock.base(), { maxAuthFailures: 1, keepaliveTimeoutMs: 5000 })
  p.start(0, onMessage)
  await sleep(400)
  const afterFirst = mock.requests.length
  await sleep(1500)
  const afterWait = mock.requests.length
  p.stop()
  mock.stop()

  assert(afterFirst === 1, `首次 401 后未重连（请求数 ${afterFirst}）`)
  assert(afterWait === 1, `熔断后持续不再重连（请求数 ${afterWait}）`)
}

// ── 场景 5：合并单话题 → bot_tag 过滤 ───────────────────────────────────────

async function scenarioBotTagFilter() {
  console.log("\n▶ 场景 5：合并单话题 → 带 bot_tag 的自身消息被忽略")
  const mock = startMock(() => {
    const s = ndjsonStream()
    s.send({ id: "open", event: "open", topic: "cmd-topic" })
    // 插件自己发的通知/回执：带 bot_tag → 应被忽略
    s.send({ id: "bot1", event: "message", topic: "cmd-topic", message: "已允许 oc-xxxx", tags: ["opencode"] })
    // 用户消息：无 tag → 应投递
    s.send({ id: "user1", event: "message", topic: "cmd-topic", message: "approve oc-xxxx" })
    // 用户消息但带无关 tag → 应投递（只过滤 bot_tag）
    s.send({ id: "user2", event: "message", topic: "cmd-topic", message: "say 继续", tags: ["cmd"] })
    return s.res
  })
  await mock.ready

  const { got, onMessage } = collect()
  const p = new NtfyStreamProvider(mock.base(), "cmd-topic", "notify-topic", "tk_test", 2, {
    keepaliveTimeoutMs: 5000,
    botTag: "opencode",
  })
  p.start(0, onMessage)
  await sleep(1200)
  p.stop()
  mock.stop()

  const ids = got.map((m) => m.id).join(",")
  assert(ids === "user1,user2", `仅投递非 bot 消息（实际 ${ids}）`)
  assert(!got.some((m) => m.id === "bot1"), "带 bot_tag 的自身消息被忽略")
  assert(got.every((m) => !m.tags?.includes("opencode")), "投递消息均不含 bot_tag")
}

// ── 场景 6：回执回环回归（回执标题兜底，防自激刷屏） ────────────────────────

async function scenarioReceiptLoopGuard() {
  console.log("\n▶ 场景 6：回执自激回归 → 即使缺 bot_tag，回执标题也必须被忽略")
  const mock = startMock(() => {
    const s = ndjsonStream()
    s.send({ id: "open", event: "open", topic: "cmd-topic" })
    // 模拟"回执缺 bot_tag"的故障态：标题为回执标题、无 tag → 绝不能投递（否则自激刷屏）
    s.send({ id: "receipt1", event: "message", topic: "cmd-topic", title: "opencode 回执", message: "已回答 oc-x：确认" })
    // 模拟"回执标题 + 无动词正文"（正是刷屏链路的每一环）
    s.send({ id: "receipt2", event: "message", topic: "cmd-topic", title: "opencode 回执", message: "未识别命令（未知动词: 已回答）。可用：…" })
    // 正常用户消息 → 投递
    s.send({ id: "user1", event: "message", topic: "cmd-topic", message: "status" })
    return s.res
  })
  await mock.ready

  const { got, onMessage } = collect()
  const p = new NtfyStreamProvider(mock.base(), "cmd-topic", "notify-topic", "tk_test", 2, {
    keepaliveTimeoutMs: 5000,
    botTag: "opencode",
  })
  p.start(0, onMessage)
  await sleep(1200)
  p.stop()
  mock.stop()

  const ids = got.map((m) => m.id).join(",")
  assert(ids === "user1", `仅投递用户消息，回执被拦（实际 ${ids}）`)
  assert(!got.some((m) => m.id.startsWith("receipt")), "缺 tag 的回执也因标题被过滤（防自激）")
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(56))
  console.log("  流式 ntfy 命令通道 — 冒烟测试")
  console.log("═".repeat(56))
  await scenarioReconnectAndDedup()
  await scenarioInvalidSince()
  await scenarioWatchdog()
  await scenarioAuthBreaker()
  await scenarioBotTagFilter()
  await scenarioReceiptLoopGuard()
  console.log("\n" + "═".repeat(56))
  if (failures === 0) {
    console.log("✅ 全部通过")
    process.exit(0)
  }
  console.log(`❌ ${failures} 项失败`)
  process.exit(1)
}

void main()
