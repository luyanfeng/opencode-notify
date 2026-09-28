// opencode V2 事件类型来自 @opencode/plugin@2.x 依赖的 @opencode/schema。
// 运行时收到的事件是 { type: string; data: any } —— V2 已把 V1 的 `properties` 统一改名为 `data`。
// 这里直接使用 any 避免对 opencode 内部类型的耦合。
import type { Message } from "./message.js"
import { formatTitle, formatBody, defaultBody } from "./message.js"
import { debug } from "./log.js"

/** V2 事件形状（结构化类型见 .planning/2026-09-28-oc2-migration/plan.md 的事件映射表） */
export interface V2Event {
  type: string
  data?: Record<string, unknown>
}

/**
 * `session.execution.interrupted` 中**需要发 run_cancelled 通知**的 reason
 *
 * reason 取值（V2 `SessionExecutionInterrupted`）与各自的处理：
 * - `user`       用户按中断/Ctrl+C（宿主结算里对应 `AbortError`）——用户唯一主动取消，
 *                与 V1 的 `MessageAbortedError` 口径一致，**通知**
 * - `shutdown`   opencode 关闭/重载。宿主自己就两处特殊排除它（不写 `idle_outcome`、
 *                通知走独立分支），此时发"用户取消"纯属噪音 —— **静默**
 * - `superseded` 本次执行被更新的执行取代。新的执行会自行发出完成/失败通知，
 *                这里再报一次"取消"是重复打扰 —— **静默**
 * - `inactivity` 空闲超时。V1 时代同样不通知（无对应错误类型）—— **静默**
 *
 * 注意：静默是**不通知**，绝不降级成 `run_failed`。
 */
const NOTIFIABLE_INTERRUPT_REASONS = new Set(["user"])

/**
 * 将 opencode V2 事件映射为内部通知 Message
 *
 * 事件类型对照（V1 → V2）：
 * - "permission.asked"        → 工具权限请求（V2 的 data 是 { id, sessionID, action, resources, message? }）
 * - "form.created"            → 通用表单/提问（**取代 V1 的 question.asked**）
 * - "session.execution.failed"      → run_failed（**取代 V1 的 session.error**）
 * - "session.execution.interrupted" → run_cancelled（**取代 V1 的 MessageAbortedError 判定**）
 *
 * 注意：session.idle / session.status(idle) 不在本函数处理，
 * 由 index.ts 中的会话状态机统一走 run_completed 逻辑。
 *
 * @param event opencode 事件对象
 * @param enabledEvents 启用的事件列表，用于过滤
 * @returns Message | null — 不关心的事件返回 null
 */
export function route(
  event: V2Event,
  enabledEvents?: string[],
): Message | null {
  const enabled = new Set(enabledEvents ?? [])
  const { type } = event
  const data = event.data ?? {}
  // 会话 ID：绝大多数事件直接带 data.sessionID；
  // form.* 事件把会话 ID 放在 data.form.sessionID（见下方 form 分支的覆盖处理）
  const sessionID = (data.sessionID as string) ?? "unknown"

  /**
   * 构造 Message 的辅助函数
   * 统一处理 sessionID、title（带会话前缀）、body（结构化格式）
   */
  function makeMsg(evt: string, detail: string, overrideSessionID?: string): Message {
    const msg: Message = {
      agent: "opencode",
      event: evt,
      sessionID: overrideSessionID ?? sessionID,
      title: formatTitle(evt),
      body: detail,
    }
    // 将 body 格式化为结构化通知正文
    msg.body = formatBody(msg)
    return msg
  }

  // form.created — 通用表单/提问（V2 取代 V1 的 question.asked）
  if (type === "form.created" && enabled.has("permission_required")) {
    const form = (data.form ?? {}) as Record<string, unknown>
    const text = String(form.title ?? "")
    return makeMsg(
      "permission_required",
      text ? `需要确认: ${truncate(text, 200)}` : defaultBody("permission_required"),
      (form.sessionID as string) ?? undefined,
    )
  }

  // permission.asked — 工具权限请求
  // V2 不再有 properties.tool / properties.permission，改为 action + resources + message
  if (type === "permission.asked" && enabled.has("permission_required")) {
    const action = String(data.action ?? "")
    const message = String(data.message ?? "")
    const resources = Array.isArray(data.resources) ? (data.resources as unknown[]).map(String) : []
    const desc = [action, message, ...resources].filter(Boolean).join(" - ")
    return makeMsg(
      "permission_required",
      desc
        ? `操作「${desc}」需要您的授权许可`
        : defaultBody("permission_required"),
    )
  }

  // session.execution.interrupted → run_cancelled（V1 靠 session.error 里的
  // MessageAbortedError 判定，V2 有原生事件且带 reason，无需再猜错误名）
  if (type === "session.execution.interrupted") {
    if (!enabled.has("run_cancelled")) return null
    // 只对"用户主动中断"通知；shutdown/superseded/inactivity 各有静默理由，
    // 详见 NOTIFIABLE_INTERRUPT_REASONS 的逐项说明
    const reason = String(data.reason ?? "")
    if (!NOTIFIABLE_INTERRUPT_REASONS.has(reason)) {
      debug(`events: session.execution.interrupted reason=${reason || "(缺失)"} 非用户主动中断，不发 run_cancelled`)
      return null
    }
    return makeMsg("run_cancelled", defaultBody("run_cancelled"))
  }

  // session.execution.failed → run_failed
  if (type === "session.execution.failed") {
    if (enabled.has("run_failed")) {
      const err = (data.error ?? {}) as Record<string, unknown>
      const errMsg = String(err.message ?? err.name ?? data.reason ?? defaultBody("run_failed"))
      return makeMsg("run_failed", `错误: ${truncate(errMsg, 200)}`)
    }
  }

  return null
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s
}
