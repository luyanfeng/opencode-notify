#!/usr/bin/env bun
/**
 * 协议层单测冒烟（凭证强制协议）：不依赖网络/opencode，验证
 *   0. isSelfMessage：自身消息识别（回环防御）
 *   1. parser：凭证强制语法（动词+令牌 / 令牌+数字 / 令牌+文本）+ 无凭证一律拒绝
 *   2. config：合并单话题 vs 分离模式 / botTag / copyButton
 *   3. controller 按钮编排：凭证在各动作里、权限 3 http、提问、续接 copy
 *   4. sessions：展示码生成与回收
 *   5. pending：一次性消费 / session 型可复用 / 过期静默
 *
 * 运行：bun scripts/control-protocol-smoke.ts
 */
import { parseCommand } from "../control/parser.js"
import { resolveConfig } from "../config.js"
import { ControlController } from "../control/controller.js"
import { SessionCodes } from "../control/sessions.js"
import { PendingRegistry } from "../control/pending.js"
import { isSelfMessage, RECEIPT_TITLE } from "../control/ntfy-common.js"
import { configureLog } from "../log.js"
import type { ReplyConfig, OpencodeBridge, Command, PendingItem } from "../control/types.js"
import type { PluginConfig } from "../config.js"

configureLog("off")

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✅ ${label}`)
  else { failures++; console.log(`  ❌ ${label}`) }
}

const T = "oc-abcd-123456" // 形如真实令牌（实例 abcd）

// ── 0. isSelfMessage ────────────────────────────────────────────────────────

function testSelfMessage() {
  console.log("\n▶ isSelfMessage：自身消息识别（回环防御）")
  assert(isSelfMessage({ tags: ["opencode"] }, "opencode"), "带 bot_tag → 识别为自身消息")
  assert(!isSelfMessage({ tags: ["cmd"] }, "opencode"), "无关 tag → 非自身消息")
  assert(!isSelfMessage({}, "opencode"), "无 tag 无回执标题 → 非自身消息")
  assert(isSelfMessage({ title: RECEIPT_TITLE }, "opencode"), "缺 tag 但标题为回执 → 识别为自身消息")
  assert(isSelfMessage({ title: RECEIPT_TITLE, tags: [] }, "opencode"), "空 tag 数组 + 回执标题 → 识别")
  assert(!isSelfMessage({ title: "opencode - 权限请求" }, "opencode"), "普通通知标题（无tag）不误判")
}

// ── 1. parser：凭证强制语法 ─────────────────────────────────────────────────

function testParser() {
  console.log("\n▶ parser：凭证强制语法（无令牌一律拒绝）")

  // 合法：动词 + 令牌
  const appr = parseCommand(`approve ${T}`)
  assert(appr.ok && appr.command.action === "approve" && appr.command.ref === T, "approve <令牌> → approve(ref)")
  const deny = parseCommand(`deny ${T}`)
  assert(deny.ok && deny.command.action === "deny", "deny <令牌> → deny")
  const ans = parseCommand(`answer ${T} 生产环境 k8s`)
  assert(ans.ok && ans.command.action === "answer" && ans.command.ref === T && ans.command.text === "生产环境 k8s", "answer <令牌> <文本> → answer")
  const say = parseCommand(`say ${T} 继续补测试`)
  assert(say.ok && say.command.action === "say" && say.command.ref === T && say.command.text === "继续补测试", "say <令牌> <文本> → say")
  const stop = parseCommand(`stop ${T}`)
  assert(stop.ok && stop.command.action === "stop" && stop.command.ref === T, "stop <令牌> → stop")
  const status = parseCommand(`status ${T}`)
  assert(status.ok && status.command.action === "status" && "ref" in status.command && status.command.ref === T, "status <令牌> → status")

  // 合法：令牌 + 数字（选选项）
  const sel = parseCommand(`select ${T} 2`)
  assert(sel.ok && sel.command.action === "choose" && sel.command.ref === T && sel.command.index === 2, "select <令牌> 2 → choose(2)")
  const selText = parseCommand(`select ${T} 都不对`)
  assert(selText.ok && selText.command.action === "answer" && selText.command.text === "都不对", "select <令牌> 文字 → answer(自由回答)")
  // select 只有自身一个入口，不再收 option/选择/选项 同义词
  assert(!parseCommand(`option ${T} 3`).ok, "option 同义词已移除")
  assert(!parseCommand(`选择 ${T} 1`).ok, "选择 同义词已移除")
  // 无动词简写已废除：所有命令必须有明确动词
  const noVerb = parseCommand(`${T} 2`)
  assert(!noVerb.ok, "<令牌> 2（无动词简写）→ 拒绝（所有命令必须显式）")

  // 合法：标题动词 + 正文令牌
  const titleVerb = parseCommand(T, "approve")
  assert(titleVerb.ok && titleVerb.command.action === "approve", "标题动词 approve + 正文令牌 → approve")

  // 非法：无令牌 → 一律拒绝（多实例安全的核心）
  assert(!parseCommand("2").ok, "裸数字 2 → 拒绝（无凭证）")
  assert(!parseCommand("12").ok, "裸数字 12 → 拒绝")
  assert(!parseCommand("approve").ok, "approve 无令牌 → 拒绝")
  assert(!parseCommand("approve oc-xxxx").ok, "approve 令牌格式不全 → 拒绝")
  assert(!parseCommand("say 继续补测试").ok, "say 无令牌 → 拒绝")
  assert(!parseCommand("say sc-ab12 继续").ok, "say sc-xxxx → 拒绝（会话码已退役为展示）")
  assert(!parseCommand("stop sc-ab12").ok, "stop sc-xxxx → 拒绝")
  assert(!parseCommand("answer 生产环境").ok, "answer 无令牌 → 拒绝")
  assert(!parseCommand("status").ok, "status 无令牌 → 拒绝")
  assert(!parseCommand("帮我看看日志").ok, "无动词文本 → 拒绝（静默处理）")
  assert(!parseCommand(`${T} 0`).ok, "<令牌> 0（无动词简写）→ 拒绝")

  // secret 兼容
  const secretSel = parseCommand(`mysecret select ${T} 3`, undefined, "mysecret")
  assert(secretSel.ok && secretSel.command.action === "choose" && secretSel.command.index === 3, "secret select <令牌> 3 → choose(3)")
  const secretNo = parseCommand("approve", undefined, "mysecret")
  assert(!secretNo.ok, "secret 模式下无令牌动词 → 拒绝")
}

// ── 2. config ───────────────────────────────────────────────────────────────

const baseNtfy = {
  mode: "all" as const,
  server_url: "https://n.example.com",
  token: "tk_x",
  topic: "opencode",
}

function testConfig() {
  console.log("\n▶ config：合并单话题 vs 分离模式")

  const merged = resolveConfig({ channels: { ntfy: { ...baseNtfy, reply: { enabled: true } } } } as PluginConfig)
  const m = merged.channels.ntfy!.reply!
  assert(m.merged === true, "合并模式：merged=true")
  assert(m.commandTopic === "opencode", `合并模式：commandTopic=topic（实际 ${m.commandTopic}）`)
  assert(m.botTag === "opencode", "合并模式：botTag 默认 opencode")
  assert(m.copyButton === true, "合并模式：copyButton 默认 true")

  const sep = resolveConfig({
    channels: { ntfy: { ...baseNtfy, reply: { enabled: true, command_topic: "opencode-cmd" } } },
  } as PluginConfig)
  const s = sep.channels.ntfy!.reply!
  assert(s.merged === false, "分离模式：merged=false")
  assert(s.commandTopic === "opencode-cmd", "分离模式：commandTopic 用配置值")
  assert(s.copyButton === false, "分离模式：不启用 copy 按钮")
}

// ── 3. controller 按钮编排 + 凭证门卫语义 ───────────────────────────────────

function mkController(copyButton = true, bridgeOverride?: Partial<OpencodeBridge>): ControlController {
  const reply: ReplyConfig = {
    provider: "ntfy",
    serverUrl: "https://n.example.com",
    enabled: true,
    pollIntervalMs: 3000,
    tokenTtlMs: 1800000,
    maxPending: 30,
    receipt: true,
    receiptPriority: 2,
    buttons: true,
    buttonAlways: true,
    ntfyToken: "tk_x",
    commandTopic: "opencode",
    notifyTopic: "opencode",
    transport: "stream",
    merged: true,
    botTag: "opencode",
    copyButton,
  }
  // 按钮编排测试不触达宿主，用一个"永不生效"的空桥接即可；
  // 表单应答语义测试需要桥接按场景抛错，故允许覆盖。
  const bridge: OpencodeBridge = {
    replyPermission: async () => {},
    replyForm: async () => {},
    prompt: async () => {},
    interrupt: async () => {},
    ...bridgeOverride,
  }
  return new ControlController(reply, bridge)
}

function testButtons() {
  console.log("\n▶ controller：按钮编排 + 凭证")

  const ctl = mkController()

  const perm = ctl.registerPending("permission", "req-perm", "ses_1", "bash")
  const permBtns = ctl.buildButtons(perm)
  assert(permBtns.length === 3, `权限 3 个按钮（实际 ${permBtns.length}）`)
  assert(permBtns.every((b) => b.body?.includes(perm.code)), "权限按钮 body 均携带该条令牌")

  const q2 = ctl.registerPending("form", "req-q2", "ses_1", "继续？", ["是", "否"], { answerKey: "q0", optionValues: ["是", "否"] })
  const q2Btns = ctl.buildButtons(q2)
  assert(q2Btns.length === 3, `提问≤2 选项：选项+copy=3（实际 ${q2Btns.length}）`)
  assert(q2Btns.filter((b) => b.value)?.[0]?.value === `select ${q2.code} `, "copy 值为 `select <令牌> `（带尾空格，粘贴补数字）")
  // 按钮 body 必须提交 option.value（回传值），而不是 label
  assert(q2Btns[0]?.body === `answer ${q2.code} 是`, `选项按钮提交回传值（实际 ${q2Btns[0]?.body}）`)

  const q5 = ctl.registerPending("form", "req-q5", "ses_1", "选哪个？", ["a", "b", "c", "d", "e"])
  assert(ctl.buildButtons(q5).length === 1 && ctl.buildButtons(q5)[0].value !== undefined, "提问≥3 选项：仅 1 个 copy 按钮")

  // 完成类：say 复制值携带 **session 型凭证令牌**（而非会话码 sc-）
  const sayCopy = ctl.buildSayCopyButton("ses_1")
  assert(sayCopy?.value?.startsWith("say oc-") === true, `续接 copy 值形如 say oc-xxx（实际 ${sayCopy?.value}）`)
  assert(sayCopy?.value?.endsWith(" ") === true, "续接 copy 值带尾空格")
  assert(ctl.buildStatusButton("ses_1").body?.startsWith("status oc-") === true, "状态按钮 body 携带凭证")

  const noCopy = mkController(false)
  const q2No = noCopy.registerPending("form", "req-nc", "ses_1", "继续？", ["是", "否"])
  assert(noCopy.buildButtons(q2No).length === 2, "copy_button=false：提问≤2 只剩 2 个选项按钮")
  const q5No = noCopy.registerPending("form", "req-nc5", "ses_1", "选哪个？", ["a", "b", "c", "d", "e"])
  assert(noCopy.buildButtons(q5No).length === 3, "copy_button=false：提问≥3 退回 3 个选项按钮")
  assert(noCopy.buildSayCopyButton("ses_1") === undefined, "copy_button=false：无续接复制按钮")
}

// ── 4. sessions（展示码） ───────────────────────────────────────────────────

function testSessions() {
  console.log("\n▶ sessions：展示码生成与回收")
  const sc = new SessionCodes()
  const a = sc.codeFor("ses_a")!
  assert(a.startsWith("sc-"), `展示码形如 sc-xxxx（实际 ${a}）`)
  assert(sc.codeFor("ses_a") === a, "同会话展示码稳定")
  sc.remove("ses_a")
  assert(sc.sessionFor(a) === undefined, "回收后失效")
}

// ── 5. pending：一次性 / 可复用 / 过期 ──────────────────────────────────────

function testPending() {
  console.log("\n▶ pending：凭证消费语义")
  const reg = new PendingRegistry(10, "abcd", 60_000)

  const perm = reg.add("permission", "r1", "ses_1", "权限")
  assert(reg.consume(perm.code) !== undefined, "permission 第一次消费成功")
  assert(reg.consume(perm.code) === undefined, "permission 第二次消费失败（一次性）")

  const sess = reg.add("session", "session:ses_1", "ses_1", "续接")
  assert(reg.consume(sess.code) !== undefined, "session 第一次使用成功")
  assert(reg.consume(sess.code) !== undefined, "session TTL 内可反复使用（可复用）")

  // 过期：TTL=0 不可能（构造器最小 30min），用极短 TTL 的独立注册表模拟
  const reg2 = new PendingRegistry(10, "abcd", 1) // 1ms
  const it2 = reg2.add("form", "r2", "ses_2", "提问")
  await0(5).then(() => {
    assert(reg2.getByCode(it2.code) === undefined, "过期凭证查无此证（静默忽略的前提）")
    done()
  })
  function done() { /* 异步收尾在 main 中统计 */ }
}

// ── 3b. controller：表单应答的令牌消费语义（任务 3.3）────────────────────────

async function testFormReplyTokenSemantics() {
  console.log("\n▶ controller：表单应答的令牌消费语义")

  // execute 是私有方法；冒烟脚本按其窄契约（Command + PendingItem → 回执文本/null）调用。
  // 之所以不走 onRawMessage：那需要真实 provider 与回执通道，属于集成层，不属本冒烟范围。
  type ExecuteFn = (cmd: Command, item: PendingItem) => Promise<string | null>
  const callExecute = (ctl: ControlController, cmd: Command, item: PendingItem): Promise<string | null> =>
    (ctl as unknown as { execute: ExecuteFn }).execute(cmd, item)

  // ── 成功：桥接正常 → 回执「已回答」且令牌被消费 ──
  {
    const ctl = mkController()
    const item = ctl.registerPending("form", "req-ok", "ses_1", "继续？", ["是", "否"], {
      answerKey: "q0",
      optionValues: ["是", "否"],
    })
    const receipt = await callExecute(ctl, { action: "answer", ref: item.code, text: "随便" }, item)
    assert(receipt === `已回答 ${item.code}`, `成功路径回执为「已回答 <令牌>」（实际 ${receipt}）`)
    assert(ctl.registry.getByCode(item.code) === undefined, "成功后令牌被消费（查无此证）")
  }

  // ── 失败（TUI 报已结算）→ 回执含原因，且令牌**保留** ──
  {
    const ctl = mkController(undefined, {
      replyForm: async () => {
        throw new Error("该提问已被回答或已取消（宿主已结算）")
      },
    })
    const item = ctl.registerPending("form", "req-settled", "ses_1", "继续？", ["是", "否"], {
      answerKey: "q0",
      optionValues: ["是", "否"],
    })
    const receipt = await callExecute(ctl, { action: "choose", ref: item.code, index: 1 }, item)
    assert(receipt !== null && receipt.includes("令牌未消费"), `失败回执声明令牌未消费（实际 ${receipt}）`)
    assert(receipt !== null && receipt.includes("已被回答或已取消"), `失败回执携带原因（实际 ${receipt}）`)
    assert(ctl.registry.getByCode(item.code) !== undefined, "失败后令牌保留（可重试）")
  }

  // ── 失败（超时 / 无 TUI）→ 回执含提示，且令牌**保留** ──
  {
    const ctl = mkController(undefined, {
      replyForm: async () => {
        throw new Error("当前没有终端客户端在运行（等待应答确认超过 5 秒），请回电脑处理")
      },
    })
    const item = ctl.registerPending("form", "req-timeout", "ses_1", "继续？", ["是", "否"], {
      answerKey: "q0",
      optionValues: ["是", "否"],
    })
    const receipt = await callExecute(ctl, { action: "choose", ref: item.code, index: 2 }, item)
    assert(receipt !== null && receipt.includes("令牌未消费"), `超时回执声明令牌未消费（实际 ${receipt}）`)
    assert(receipt !== null && receipt.includes("没有终端客户端"), `超时回执说明无终端客户端（实际 ${receipt}）`)
    assert(ctl.registry.getByCode(item.code) !== undefined, "超时后令牌保留（可重试）")
  }

  // ── 令牌与动作不匹配 → 静默（null），不消费 ──
  {
    const ctl = mkController()
    const permItem = ctl.registerPending("permission", "req-perm2", "ses_1", "bash")
    const receipt = await callExecute(ctl, { action: "answer", ref: permItem.code, text: "x" }, permItem)
    assert(receipt === null, `权限令牌用于 answer → 静默 null（实际 ${receipt}）`)
    assert(ctl.registry.getByCode(permItem.code) !== undefined, "静默路径不消费令牌")
  }
}

function await0(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

let asyncDone = false
async function main() {
  console.log("═".repeat(56))
  console.log("  协议层 — 单测冒烟（凭证强制协议）")
  console.log("═".repeat(56))
  testSelfMessage()
  testParser()
  testConfig()
  testButtons()
  testSessions()
  testPending()
  await await0(30) // 等 testPending 的过期断言
  await testFormReplyTokenSemantics()
  console.log("\n" + "═".repeat(56))
  if (failures === 0) {
    console.log("✅ 全部通过")
    process.exit(0)
  }
  console.log(`❌ ${failures} 项失败`)
  process.exit(1)
}

void main()
