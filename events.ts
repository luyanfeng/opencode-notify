// Event 类型来自 @opencode-ai/sdk/gen/types.gen.d.ts
// 但通过 event hook 收到时是 { type: string; properties: any }
// 这里直接使用 any 避免对 SDK 内部类型的依赖
import type { Message } from "./message.js"
import { formatTitle, defaultBody } from "./message.js"

/**
 * 将 opencode event hook 收到的 Event 映射为内部通知 Message
 *
 * 实际事件类型 (from @opencode-ai/sdk gen types):
 * - "permission.updated"      → 新权限请求
 * - "permission.replied"      → 权限已回复
 * - "session.idle"            → 会话空闲（等待输入）
 * - "session.status"          → 会话状态变化（含 idle/busy/retry）
 * - "session.error"           → 会话错误
 * - "session.created"         → 新会话
 *
 * @returns Message | null — 不关心的事件返回 null
 */
export function route(
  event: { type: string; properties: Record<string, any> },
  enabledEvents?: string[],
): Message | null {
  const enabled = new Set(enabledEvents ?? [])
  const { type, properties } = event

  // question.asked — 通用问题询问（权限/确认等均走此事件）
  // properties 结构待实测确认
  if (type === "question.asked" && enabled.has("permission_required")) {
    const text = properties.text ?? properties.message ?? ""
    return {
      agent: "opencode",
      event: "permission_required",
      sessionID: properties.sessionID ?? "unknown",
      title: formatTitle("permission_required"),
      body: text ? `需要确认: ${truncate(text, 200)}` : defaultBody("permission_required"),
    }
  }

  // permission.asked — 工具权限请求
  if (type === "permission.asked" && enabled.has("permission_required")) {
    // properties: { id, sessionID, permission, patterns, metadata, always, tool }
    // tool 可能是对象 { name, ... } 或字符串
    const toolName = typeof properties.tool === "object" && properties.tool
      ? (properties.tool.name ?? properties.tool.type ?? "")
      : (properties.tool ?? "")
    const permission = properties.permission ?? ""
    const desc = [toolName, permission].filter(Boolean).join(" - ")
    return {
      agent: "opencode",
      event: "permission_required",
      sessionID: properties.sessionID ?? "unknown",
      title: formatTitle("permission_required"),
      body: desc
        ? `操作「${desc}」需要您的授权许可`
        : defaultBody("permission_required"),
    }
  }

  // 会话错误 → run_failed
  if (type === "session.error" && enabled.has("run_failed")) {
    const err = properties.error
    const errMsg = err?.message ?? err?.name ?? defaultBody("run_failed")
    return {
      agent: "opencode",
      event: "run_failed",
      sessionID: properties.sessionID ?? "unknown",
      title: formatTitle("run_failed"),
      body: `错误: ${truncate(String(errMsg), 200)}`,
    }
  }

  // 会话空闲 → input_required
  if (type === "session.idle" && enabled.has("input_required")) {
    return {
      agent: "opencode",
      event: "input_required",
      sessionID: properties.sessionID ?? "unknown",
      title: formatTitle("input_required"),
      body: defaultBody("input_required"),
    }
  }

  // session.status 也可能包含 idle 状态
  if (type === "session.status" && enabled.has("input_required")) {
    const status = properties.status
    if (status?.type === "idle") {
      return {
        agent: "opencode",
        event: "input_required",
        sessionID: properties.sessionID ?? "unknown",
        title: formatTitle("input_required"),
        body: defaultBody("input_required"),
      }
    }
  }

  // 新会话创建 → 可跟踪任务开始
  // 当前暂不直接通知，留作 run_completed 检测的基础
  if (type === "session.created") {
    // 预留: 可在这里记录会话开始时间，用于后续推断任务完成
    return null
  }

  return null
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s
}
