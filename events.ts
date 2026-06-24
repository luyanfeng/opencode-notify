// Event 类型来自 @opencode-ai/sdk/gen/types.gen.d.ts
// 但通过 event hook 收到时是 { type: string; properties: any }
// 这里直接使用 any 避免对 SDK 内部类型的依赖
import type { Message } from "./message.js"
import { formatTitle, formatBody, defaultBody } from "./message.js"

/**
 * 将 opencode event hook 收到的 Event 映射为内部通知 Message
 *
 * 实际事件类型 (from @opencode-ai/sdk gen types):
 * - "permission.updated"      → 新权限请求
 * - "permission.replied"      → 权限已回复
 * - "session.error"           → 会话错误
 * - "session.created"         → 新会话
 *
 * 注意：session.idle / session.status(idle) 不在本函数处理，
 * 由 index.ts 中的会话状态机统一走 run_completed 逻辑。
 *
 * @param event opencode 事件对象
 * @param enabledEvents 启用的事件列表，用于过滤
 * @returns Message | null — 不关心的事件返回 null
 */
export function route(
  event: { type: string; properties: Record<string, unknown> },
  enabledEvents?: string[],
): Message | null {
  const enabled = new Set(enabledEvents ?? [])
  const { type, properties } = event
  const sessionID = (properties.sessionID as string) ?? "unknown"

  /**
   * 构造 Message 的辅助函数
   * 统一处理 sessionID、title（带会话前缀）、body（结构化格式）
   */
  function makeMsg(evt: string, detail: string): Message {
    const msg: Message = {
      agent: "opencode",
      event: evt,
      sessionID,
      title: formatTitle(evt),
      body: detail,
    }
    // 将 body 格式化为结构化通知正文
    msg.body = formatBody(msg)
    return msg
  }

  // question.asked — 通用问题询问（权限/确认等均走此事件）
  if (type === "question.asked" && enabled.has("permission_required")) {
    const text = String(properties.text ?? properties.message ?? "")
    return makeMsg(
      "permission_required",
      text ? `需要确认: ${truncate(text, 200)}` : defaultBody("permission_required"),
    )
  }

  // permission.asked — 工具权限请求
  if (type === "permission.asked" && enabled.has("permission_required")) {
    const tool = properties.tool
    const toolName = typeof tool === "object" && tool !== null
      ? (String((tool as Record<string, unknown>).name ?? (tool as Record<string, unknown>).type ?? ""))
      : (String(tool ?? ""))
    const permission = String(properties.permission ?? "")
    const desc = [toolName, permission].filter(Boolean).join(" - ")
    return makeMsg(
      "permission_required",
      desc
        ? `操作「${desc}」需要您的授权许可`
        : defaultBody("permission_required"),
    )
  }

  // 会话错误 → run_cancelled / run_failed
  if (type === "session.error") {
    const err = properties.error as Record<string, unknown> | undefined

    // 用户主动中断
    if (err?.name === "MessageAbortedError") {
      if (enabled.has("run_cancelled")) {
        const errData = err.data as Record<string, unknown> | undefined
        const msg = String(errData?.message ?? "")
        return makeMsg(
          "run_cancelled",
          msg ? `用户中断: ${truncate(msg, 200)}` : defaultBody("run_cancelled"),
        )
      }
      return null
    }

    // 真实失败
    if (enabled.has("run_failed")) {
      const errData = err?.data as Record<string, unknown> | undefined
      const errMsg = String(errData?.message ?? err?.name ?? defaultBody("run_failed"))
      return makeMsg(
        "run_failed",
        `错误: ${truncate(errMsg, 200)}`,
      )
    }
  }

  return null
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s
}
