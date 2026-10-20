#!/usr/bin/env bun
/**
 * 事件映射层冒烟：验证 `route()`（events.ts）对 opencode V2 各事件的输出。
 *
 * 重点覆盖容易回归的部分：
 *   1. form.created → permission_required（会话 ID 取自 data.form.sessionID）
 *   2. permission.asked → permission_required（action - message - resources 拼接）
 *   3. session.execution.failed → run_failed（错误取自 data.error.message）
 *   4. session.execution.interrupted → run_cancelled **按 reason 过滤**
 *      （只 user 通知；shutdown/superseded/inactivity 静默且不降级为 run_failed）
 *   5. idle 事件 route() 返回 null（run_completed 由 index.ts 状态机合成）
 *   6. 事件开关过滤（enabledEvents 主闸门）
 *
 * 运行：bun scripts/events-route-smoke.ts
 */
import { route } from "../events.js"
import type { V2Event } from "../events.js"
import { SessionTracker } from "../session-tracker.js"
import { configureLog } from "../log.js"

configureLog("off")

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✅ ${label}`)
  else { failures++; console.log(`  ❌ ${label}`) }
}

const ALL = ["permission_required", "run_completed", "run_failed", "run_cancelled"]

/** 取详情行（正文里承载业务内容的最后一行，忽略时间戳等易变行；key 列已加粗且 **后带空格） */
function detailOf(body: string): string {
  const line = body.split("\n").find((l) => l.startsWith("**输入：** "))
  return line ? line.slice("**输入：** ".length) : ""
}

// ── form.created（提问）───────────────────────────────────────────────────────

function testFormCreated() {
  console.log("\n▶ form.created：V2 提问事件")
  const msg = route({
    type: "form.created",
    data: {
      form: {
        id: "frm_1",
        sessionID: "ses_form",
        title: "要读取文件吗",
        fields: [{ key: "q0" }],
      },
    },
  }, ALL)
  assert(msg?.event === "permission_required", `映射为 permission_required（实际 ${msg?.event}）`)
  // ⚠️ form.created 的会话 ID 在 data.form.sessionID，不在 data.sessionID
  assert(msg?.sessionID === "ses_form", `会话 ID 取自 data.form.sessionID（实际 ${msg?.sessionID}）`)
  assert(detailOf(msg!.body).includes("要读取文件吗"), `详情含表单标题（实际 ${detailOf(msg!.body)}）`)

  const noTitle = route({
    type: "form.created",
    data: { form: { id: "frm_2", sessionID: "ses_form", title: "", fields: [] } },
  }, ALL)
  assert(noTitle?.event === "permission_required", "无 title 也映射为 permission_required（回退文案）")

  const off = route({
    type: "form.created",
    data: { form: { id: "frm_3", sessionID: "ses_form", title: "x", fields: [] } },
  }, ["run_completed"])
  assert(off === null, "未启用 permission_required 时返回 null")
}

// ── permission.asked ────────────────────────────────────────────────────────

function testPermissionAsked() {
  console.log("\n▶ permission.asked：V2 授权事件（action - message - resources）")
  const msg = route({
    type: "permission.asked",
    data: { id: "prm_1", sessionID: "ses_1", action: "bash", message: "command", resources: ["ls -la"] },
  }, ALL)
  assert(msg?.event === "permission_required", "映射为 permission_required")
  const detail = detailOf(msg!.body)
  assert(detail.includes("bash") && detail.includes("command") && detail.includes("ls -la"),
    `action/message/resources 全部拼接（实际 ${detail}）`)

  const bare = route({
    type: "permission.asked",
    data: { id: "prm_2", sessionID: "ses_1", action: "bash" },
  }, ALL)
  assert(detailOf(bare!.body).includes("bash"), "缺 message/resources 时只拼 action")

  const empty = route({ type: "permission.asked", data: { id: "prm_3", sessionID: "ses_1" } }, ALL)
  assert(empty?.event === "permission_required", "action 也缺失时回退文案仍成通知")
}

// ── session.execution.failed ────────────────────────────────────────────────

function testExecutionFailed() {
  console.log("\n▶ session.execution.failed：V2 原生失败事件")
  const msg = route({
    type: "session.execution.failed",
    data: { sessionID: "ses_1", error: { type: "api", message: "Rate limit exceeded" } },
  }, ALL)
  assert(msg?.event === "run_failed", `映射为 run_failed（实际 ${msg?.event}）`)
  assert(detailOf(msg!.body).includes("Rate limit exceeded"), `详情取自 data.error.message（实际 ${detailOf(msg!.body)}）`)

  const off = route({
    type: "session.execution.failed",
    data: { sessionID: "ses_1", error: { type: "api", message: "x" } },
  }, ["permission_required"])
  assert(off === null, "未启用 run_failed 时返回 null（不降级为其它事件）")
}

// ── session.execution.interrupted：reason 过滤 ──────────────────────────────

function testExecutionInterrupted() {
  console.log("\n▶ session.execution.interrupted：按 reason 过滤 run_cancelled")

  // 只有 user 通知（对应宿主的 AbortError → 用户按了中断）
  const user = route({
    type: "session.execution.interrupted",
    data: { sessionID: "ses_1", reason: "user" },
  }, ALL)
  assert(user?.event === "run_cancelled", `reason=user → run_cancelled（实际 ${user?.event}）`)

  // 其余三种静默，且绝不降级成 run_failed
  for (const reason of ["shutdown", "superseded", "inactivity"]) {
    const msg = route({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_1", reason },
    }, ALL)
    assert(msg === null, `reason=${reason} → 静默不通知（实际 ${msg?.event ?? "null"}）`)
  }

  // reason 缺失/未知同样静默（不猜、不当作 user）
  const missing = route({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } }, ALL)
  assert(missing === null, "reason 缺失 → 静默（不默认当作用户中断）")
  const unknown = route({
    type: "session.execution.interrupted",
    data: { sessionID: "ses_1", reason: "future_reason" },
  }, ALL)
  assert(unknown === null, "未知 reason → 静默（不猜）")

  // 用户中断但未启用 run_cancelled → null
  const off = route({
    type: "session.execution.interrupted",
    data: { sessionID: "ses_1", reason: "user" },
  }, ["permission_required", "run_failed"])
  assert(off === null, "未启用 run_cancelled 时返回 null")
}

// ── idle：route() 不负责 run_completed ──────────────────────────────────────

function testIdleNotRouted() {
  console.log("\n▶ idle / succeeded 事件：run_completed 由 index.ts 合成")
  const a = route({ type: "session.idle", data: { sessionID: "ses_1" } }, ALL)
  assert(a === null, "session.idle → route() 返回 null")
  const b = route({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } }, ALL)
  assert(b === null, "session.status(idle) → route() 返回 null")
  const busy = route({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } }, ALL)
  assert(busy === null, "session.status(busy) → null")

  // ⚠️ opencode 2.0.32 不发 session.idle / session.status，
  //    run_completed 改由 session.execution.succeeded 驱动（index.ts 合成）。
  //    route() 对它必须返回 null，否则 index.ts 的合成分支永远走不到。
  const ok = route({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } }, ALL)
  assert(ok === null, "session.execution.succeeded → route() 返回 null（交由 index.ts 合成）")
}

// ── 子会话判定（tracker）────────────────────────────────────────────────────

function testChildSessionDetection() {
  console.log("\n▶ 子会话判定：parentID 兜底与活跃时间不被刷新")
  const tracker = new SessionTracker(600_000)

  // 未登记 → 非子会话
  assert(!tracker.isBackground("ses_child"), "未登记的会话 → 非子会话")
  assert(tracker.getParentID("ses_child") === undefined, "未登记的会话 → 无 parentID")

  // 登记父子关系后 → 是子会话
  tracker.setParent("ses_child", "ses_parent")
  assert(tracker.isBackground("ses_child"), "setParent 后 → 判定为子会话")
  assert(tracker.getParentID("ses_child") === "ses_parent", "setParent 后 → 可取回 parentID")

  // ⚠️ setParent 不得刷新 lastActivity：否则刚登记的子会话立刻被判定为活跃
  //    （默认 60s 窗口），把本该发的通知抑制掉。
  assert(
    !tracker.isSessionActive("ses_child", 60_000),
    "setParent 不刷新活跃时间 → 不被误判为活跃",
  )

  // 父会话不是子会话
  assert(!tracker.isBackground("ses_parent"), "父会话 → 非子会话")

  // 活跃会话确实会被判定为活跃（对照组）
  tracker.markActivity("ses_parent")
  assert(
    tracker.isSessionActive("ses_parent", 60_000),
    "markActivity 后 → 被判定为活跃（对照组）",
  )
}

// ── 不关心的事件 ────────────────────────────────────────────────────────────

function testUnrelated() {
  console.log("\n▶ 无关事件：一律 null")
  for (const type of [
    "session.text.delta", "session.inbox.enqueued", "session.created", "session.renamed",
    "permission.replied", "form.replied", "form.cancelled", "session.execution.started",
  ]) {
    const msg = route({ type, data: { sessionID: "ses_1" } } as V2Event, ALL)
    assert(msg === null, `${type} → null`)
  }
}

testFormCreated()
testPermissionAsked()
testExecutionFailed()
testExecutionInterrupted()
testIdleNotRouted()
testChildSessionDetection()
testUnrelated()

console.log("\n" + "═".repeat(60))
if (failures === 0) console.log("✅ 全部通过")
else { console.log(`❌ ${failures} 项失败`); process.exit(1) }
