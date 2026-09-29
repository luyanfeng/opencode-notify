#!/usr/bin/env bun
/**
 * ntfy 真实服务集成测试（可选，需要运行时配置）
 *
 * 与纯本地冒烟（control-stream-smoke / control-protocol-smoke）不同，本脚本**连接真实
 * ntfy 服务**，因此需要 `~/.config/opencode/opencode-notify.yaml` 里已配置好
 * server_url / token / topic。注意：**token 通常按话题授权**，故测试只使用配置里的
 * 话题（随机临时话题会 403）。
 *
 * ⚠️ 会向你的手机推送测试通知（标题带「集成测试」前缀）。请勿在不想被打扰时运行。
 * 若插件正处于**合并单话题**模式，带普通文本的消息可能被插件读为命令并回执——属预期。
 *
 * 用法：
 *   bun scripts/ntfy-integration.ts tags      tags 往返 + bot_tag 过滤（自动断言）
 *   bun scripts/ntfy-integration.ts guard     回执防自激回归（自动断言；针对刷屏 bug）
 *   bun scripts/ntfy-integration.ts loopback  全链路：外部命令→插件执行→回执（自动断言）
 *   bun scripts/ntfy-integration.ts preview   通知样式预览（手机肉眼检查按钮/提示行）
 *   bun scripts/ntfy-integration.ts copy      copy 按钮样本（手机验证剪贴板）
 *   bun scripts/ntfy-integration.ts actions   动作按钮上限探测（3 个通过 / 4 个应 400）
 *
 * 不带参数默认跑 tags。
 */
import { NtfyStreamProvider } from "../control/ntfy-stream.js"
import { loadYamlConfig, resolveConfig, mergeConfig } from "../config.js"
import { configureLog } from "../log.js"
import { DEFAULT_BOT_TAG } from "../control/ntfy-common.js"
import type { RawCommandMessage } from "../control/types.js"

configureLog("off")

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface NtfyEnv {
  base: string
  token: string
  topic: string
  commandTopic: string
  botTag: string
  hostPort: string
  auth: Record<string, string>
}

function loadEnv(): NtfyEnv {
  const cfg = resolveConfig(mergeConfig(loadYamlConfig() ?? {}, {}))
  const ntfy = cfg.channels.ntfy
  if (!ntfy?.server_url || !ntfy.topic || !ntfy.token) {
    console.error("❌ ntfy 配置不完整：需要 server_url / token / topic（检查 ~/.config/opencode/opencode-notify.yaml）")
    process.exit(1)
  }
  const base = ntfy.server_url.replace(/\/+$/, "")
  return {
    base,
    token: ntfy.token,
    topic: ntfy.topic,
    commandTopic: ntfy.reply?.commandTopic ?? ntfy.topic,
    botTag: ntfy.reply?.botTag ?? DEFAULT_BOT_TAG,
    hostPort: base.replace(/^https?:\/\//, ""),
    auth: { Authorization: `Bearer ${ntfy.token}`, "Content-Type": "application/json" },
  }
}

/** 发布一条消息到测试话题，返回是否成功 */
async function publish(env: NtfyEnv, payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${env.base}/`, {
    method: "POST",
    headers: env.auth,
    body: JSON.stringify({ topic: env.topic, ...payload }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.log(`  ⚠️  HTTP ${res.status}${body ? ` ${body.slice(0, 160)}` : ""}`)
  }
  return res.ok
}

// ── 断言工具 ────────────────────────────────────────────────────────────────

let failures = 0
function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`)
  if (!cond) failures++
}

// ── tags：真实 tags 往返 + bot_tag 过滤（自动断言） ──────────────────────────

async function cmdTags(env: NtfyEnv): Promise<void> {
  console.log(`\n[tests] server=${env.base} topic=${env.topic} botTag=${env.botTag}`)
  console.log("  ⚠️  将向手机推送 3 条测试通知\n")

  const got: RawCommandMessage[] = []
  const p = new NtfyStreamProvider(env.base, env.topic, env.topic, env.token, 2, {
    keepaliveTimeoutMs: 90_000,
    botTag: env.botTag,
  })
  p.start(0, (m) => {
    got.push(m)
    console.log(`  ← 投递 id=${m.id} msg="${m.message}" tags=${JSON.stringify(m.tags ?? [])}`)
  })
  await sleep(2500) // 等长连接建立

  const nonce = () => Math.random().toString(36).slice(2, 8)
  const botMsg = `BOT-${nonce()}`
  const userMsg = `USER-${nonce()}`
  const otherMsg = `OTHER-${nonce()}`

  await publish(env, { title: "集成测试·bot标记", message: botMsg, tags: [env.botTag] })
  await publish(env, { title: "集成测试·用户消息", message: userMsg })
  await publish(env, { title: "集成测试·无关标记", message: otherMsg, tags: ["cmd"] })

  await sleep(4000)
  p.stop()

  console.log("\n断言：")
  check(!got.some((m) => m.message === botMsg), "带 bot_tag 的自身消息被忽略（防回环）")
  check(got.some((m) => m.message === userMsg), "无 tag 的用户消息被投递")
  check(got.some((m) => m.message === otherMsg), "带无关 tag 的消息被投递")
  check(got.every((m) => !m.tags?.includes(env.botTag)), "投递消息均不含 bot_tag")
}

// ── preview：通知样式预览（手机肉眼检查） ───────────────────────────────────

async function cmdPreview(env: NtfyEnv): Promise<void> {
  console.log(`\n[preview] 发送通知样式样本到 ${env.topic}（手机查看渲染）\n`)
  const selftest = `${env.base}/opencode-selftest` // 空话题，点按无副作用
  const httpAction = (label: string, body: string) => ({
    action: "http", label, url: selftest, method: "POST", headers: { Authorization: `Bearer ${env.token}` }, body, clear: true,
  })

  // 文案/模板与 index.ts + control/controller.ts 的真实实现逐字对齐（改那两处要同步这里）
  const samples: Record<string, unknown>[] = [
    {
      title: "集成测试·权限请求",
      message: "**输入：** 操作「bash」需要您的授权许可\n**令牌：** oc-c402-a1b2c3\n**回复:** approve/deny/always <令牌>",
      priority: 5, tags: [env.botTag],
      actions: [httpAction("允许", "approve oc-c402-a1b2c3"), httpAction("始终允许", "always oc-c402-a1b2c3"), httpAction("拒绝", "deny oc-c402-a1b2c3")],
    },
    {
      title: "集成测试·提问(5选项)",
      message: [
        "**输入：** 选哪个数据库？",
        "**选项：**",
        "**1 PostgreSQL**",
        "**2 MySQL**",
        "**3 SQLite**",
        "**4 MongoDB**",
        "**5 Redis**",
        "**令牌：** oc-c402-d4e5f6",
        "**回复:** select <令牌> 1~5=选选项 · select <令牌> 文字=自由回答",
      ].join("\n"),
      priority: 3, tags: [env.botTag],
      actions: [{ action: "copy", label: "复制选择命令", value: "select oc-c402-d4e5f6 ", clear: true }],
    },
    {
      title: "集成测试·提问(2选项)",
      message: "**输入：** 是否继续部署？\n**选项：**\n**1 是，继续**\n**2 否，停止**\n**令牌：** oc-c402-111111\n**回复:** select <令牌> 1~2=选选项 · select <令牌> 文字=自由回答",
      priority: 3, tags: [env.botTag],
      actions: [
        httpAction("是，继续", "answer oc-c402-111111 是，继续"),
        httpAction("否，停止", "answer oc-c402-111111 否，停止"),
        { action: "copy", label: "复制选择命令", value: "select oc-c402-111111 ", clear: true },
      ],
    },
    {
      title: "集成测试·任务完成",
      message: "**输出：** 已完成数据库迁移脚本，测试通过\n**令牌：** oc-c402-9e8d7c\n**回复:** say <令牌> 文本=继续 · stop <令牌>=中断 · status <令牌>=状态",
      priority: 3, tags: [env.botTag],
      actions: [
        { action: "copy", label: "复制续接命令", value: "say oc-c402-9e8d7c ", clear: true },
        httpAction("状态", "status oc-c402-9e8d7c"),
      ],
    },
    { title: "集成测试·回执", message: "已允许 oc-c402-a1b2c3", priority: 2, tags: [env.botTag] },
  ]

  for (const s of samples) {
    const ok = await publish(env, s)
    console.log(`  ${ok ? "→" : "⏭"} ${String(s.title)}`)
    await sleep(1200)
  }
  console.log("\n请在手机检查：按钮数量/文案、标签是否碍眼、[复制] 是否可用、提示行排版。")
}

// ── copy：copy 按钮样本 ──────────────────────────────────────────────────────

async function cmdCopy(env: NtfyEnv): Promise<void> {
  console.log(`\n[copy] 发送 copy 样本到 ${env.topic}；请在手机点[复制]后到任意输入框粘贴\n`)
  await publish(env, {
    title: "集成测试·copy续接",
    message: `点 [复制续接命令] 后粘贴，预期得到 "say oc-c402-9e8d7c␠"（末尾一个空格）`,
    priority: 4, tags: [env.botTag],
    actions: [{ action: "copy", label: "复制续接命令", value: "say oc-c402-9e8d7c ", clear: false }],
  })
  await sleep(1200)
  await publish(env, {
    title: "集成测试·copy选择",
    message: `点 [复制选择命令] 后粘贴，预期得到 "select oc-c402-d4e5f6␠"（补序号选选项 / 补文字自由回答）`,
    priority: 4, tags: [env.botTag],
    actions: [{ action: "copy", label: "复制选择命令", value: "select oc-c402-d4e5f6 ", clear: false }],
  })
  console.log("\n提示：先把 ntfy 切到后台再点 [复制]，以复现 Android 10+ 后台写剪贴板场景。")
}

// ── actions：按钮上限探测 ───────────────────────────────────────────────────

async function cmdActions(env: NtfyEnv): Promise<void> {
  console.log(`\n[actions] 探测服务端按钮上限（预期：3 个通过 / 4 个 400）\n`)
  const url = `${env.base}/opencode-selftest`
  const mk = (n: number) => ({ action: "http", label: `按钮${n}`, url, method: "POST", headers: { Authorization: `Bearer ${env.token}` }, body: `b${n}`, clear: false })

  const ok3 = await publish(env, { title: "集成测试·3按钮", message: "应有 3 个按钮", priority: 3, tags: [env.botTag], actions: [mk(1), mk(2), mk(3)] })
  console.log(`  3 个按钮：${ok3 ? "HTTP 200 ✅（通过）" : "未通过 ❌"}`)
  await sleep(1000)
  const ok4 = await publish(env, { title: "集成测试·4按钮", message: "应被服务端拒绝", priority: 3, tags: [env.botTag], actions: [mk(1), mk(2), mk(3), mk(4)] })
  console.log(`  4 个按钮：${ok4 ? "HTTP 200（意外）" : "被拒绝 ✅（符合服务端硬限 3 个）"}`)

  check(ok3, "3 个动作被接受")
  check(!ok4, "4 个动作被拒绝（硬限 3）")
}

// ── guard：回执防自激回归（针对刷屏 bug） ───────────────────────────────────

async function cmdGuard(env: NtfyEnv): Promise<void> {
  console.log(`\n[guard] 回执防自激回归（server=${env.base} topic=${env.topic}）`)
  console.log("  原理：插件自身回执必须被订阅端忽略；否则「回执→未识别→再回执」自激刷屏。\n")

  const got: RawCommandMessage[] = []
  const sub = new NtfyStreamProvider(env.base, env.commandTopic, env.topic, env.token, 2, {
    keepaliveTimeoutMs: 90_000,
    botTag: env.botTag,
  })
  sub.start(0, (m) => {
    got.push(m)
    console.log(`  ← 投递 id=${m.id} title="${m.title}" msg="${m.message}"`)
  })
  await sleep(2500)

  // 正文故意含"未识别命令"字样，模拟刷屏链路的每一环
  const nonce = `rcpt-${Math.random().toString(36).slice(2, 8)}`
  const text = `未识别命令（未知动词: 已回答）。${nonce}`
  console.log(`  发布回执："${text}"`)
  await sub.publishReceipt(text)

  await sleep(4000)
  sub.stop()

  console.log("\n断言：")
  check(!got.some((m) => m.message.includes(nonce)), "回执未被当作命令投递（防自激）")
  check(got.length === 0, `订阅端未投递任何消息（实际 ${got.length}）`)
}

// ── loopback：全链路（外部命令→插件执行→回执） ──────────────────────────────

/**
 * 用**原始订阅**（不经 provider 的 isSelfMessage 过滤）监听话题，才能看到插件回执。
 * 返回一个可读取已收消息的句柄 + 停止函数。
 */
function rawSubscribe(env: NtfyEnv) {
  const controller = new AbortController()
  const messages: { title?: string; message?: string; tags?: string[] }[] = []
  const run = async () => {
    const url = `${env.base}/${encodeURIComponent(env.commandTopic)}/json`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.token}` }, signal: controller.signal })
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const m = JSON.parse(line) as { event?: string; title?: string; message?: string; tags?: string[] }
            if (m.event === "message") messages.push({ title: m.title, message: m.message, tags: m.tags })
          } catch { /* 忽略非 JSON 行 */ }
        }
      }
    } catch { /* abort 时忽略 */ }
  }
  void run()
  return { messages, stop: () => controller.abort() }
}

async function cmdLoopback(env: NtfyEnv): Promise<void> {
  console.log(`\n[loopback] 全链路：外部命令 → 插件执行 → 回执`)
  console.log(`  server=${env.base} commandTopic=${env.commandTopic} botTag=${env.botTag}`)
  console.log("  ⚠️ 要求 opencode 正在运行且插件已启用（否则收不到回执）\n")

  const sub = rawSubscribe(env)
  await sleep(2500) // 等订阅建立

  const nonce = Math.random().toString(36).slice(2, 8)
  const cmd = `status ${nonce}` // status 免 pending；尾随 nonce 仅作日志区分（parser 会忽略多余参数）
  console.log(`  ① 外部发布命令（无 tag）: "${cmd}"`)
  await publish(env, { title: `外部命令`, message: cmd })

  await sleep(5000) // 等插件处理 + 回执
  sub.stop()

  const receipt = sub.messages.find((m) => m.title === "opencode 回执")
  const sawCmd = sub.messages.some((m) => m.message?.includes(nonce))

  console.log(`\n  原始订阅共收到 ${sub.messages.length} 条：`)
  for (const m of sub.messages) console.log(`    - title="${m.title}" tags=${JSON.stringify(m.tags ?? [])} msg="${(m.message ?? "").slice(0, 80)}"`)

  console.log("\n断言：")
  check(sawCmd, "原始订阅收到脚本发出的命令")
  check(!!receipt, "收到插件回执（证明插件已处理外部命令）")
  if (receipt) check(receipt.tags?.includes(env.botTag) === true, `回执带 bot_tag（实际 ${JSON.stringify(receipt.tags)}）`)
}

// ── gate：无凭证命令必须静默（凭证强制协议的核心安全验证） ──────────────────

async function cmdGate(env: NtfyEnv): Promise<void> {
  console.log(`\n[gate] 无凭证命令必须被静默忽略（不得执行、不得回执）`)
  console.log(`  server=${env.base} commandTopic=${env.commandTopic}\n`)

  // 原始订阅（不过滤自身消息）：若插件错误地响应了无凭证命令，这里能看到回执
  const sub = rawSubscribe(env)
  await sleep(2500)

  const nonce = Math.random().toString(36).slice(2, 8)
  const probes: [string, string][] = [
    ["裸数字", "1"],
    ["裸数字越界", "99"],
    ["裸 say", "say 继续干活"],
    ["旧会话码 say", "say sc-ab12 继续"],
    ["无令牌 approve", "approve"],
    ["无动词文本", `hello-${nonce}`],
    ["伪造令牌", `approve oc-0000-000000`],
  ]
  for (const [label, msg] of probes) {
    console.log(`  → 发布[${label}]："${msg}"`)
    await publish(env, { title: `集成测试·${label}`, message: msg })
    await sleep(1500)
  }

  await sleep(3000)
  sub.stop()

  const receipts = sub.messages.filter((m) => m.title === "opencode 回执")
  console.log(`\n  原始订阅共收到 ${sub.messages.length} 条，其中回执 ${receipts.length} 条`)
  for (const m of sub.messages) console.log(`    - title="${m.title}" msg="${(m.message ?? "").slice(0, 70)}"`)

  console.log("\n断言：")
  check(receipts.length === 0, `无凭证命令 0 回执（实际 ${receipts.length}，>0 即违反凭证强制协议）`)
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "tags"
  console.log("═".repeat(56))
  console.log("  ntfy 真实服务集成测试")
  console.log("═".repeat(56))
  const env = loadEnv()
  switch (cmd) {
    case "tags": await cmdTags(env); break
    case "guard": await cmdGuard(env); break
    case "gate": await cmdGate(env); break
    case "loopback": await cmdLoopback(env); break
    case "preview": await cmdPreview(env); break
    case "copy": await cmdCopy(env); break
    case "actions": await cmdActions(env); break
    default:
      console.error(`未知子命令: ${cmd}（可用: tags | guard | gate | loopback | preview | copy | actions）`)
      process.exit(1)
  }
  if (cmd === "tags" || cmd === "actions" || cmd === "guard" || cmd === "gate" || cmd === "loopback") {
    console.log("\n" + "═".repeat(56))
    if (failures === 0) {
      console.log("✅ 全部通过")
      process.exit(0)
    }
    console.log(`❌ ${failures} 项失败`)
    process.exit(1)
  }
}

void main()
