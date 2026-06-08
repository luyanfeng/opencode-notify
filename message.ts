/** 内部通知消息 */
export interface Message {
  /** 触发事件的 agent 名称 */
  agent: string
  /** 通知事件类型 */
  event: string
  /** 会话 ID，用于去重 */
  sessionID: string
  /** 通知标题 */
  title: string
  /** 通知正文 */
  body: string
  /** 工作目录 */
  workspace?: string
}

/** 事件中文标签映射 */
const EVENT_LABELS: Record<string, string> = {
  permission_required: "需要授权",
  input_required: "等待输入",
  run_completed: "任务完成",
  run_failed: "任务失败",
  run_cancelled: "用户取消",
  session_idle: "会话空闲",
}

/**
 * 截短会话 ID 便于阅读
 */
function shortSession(sessionID: string): string {
  if (!sessionID || sessionID === "unknown") return "未知"
  return sessionID
}

/**
 * 格式化通知标题
 * @param event 事件类型
 * @param sessionID 会话 ID（可选，传入后在标题前加会话标签）
 */
export function formatTitle(event: string, _sessionID?: string): string {
  const label = EVENT_LABELS[event] ?? event
  return `opencode - ${label}`
}

/**
 * 创建默认通知正文
 */
export function defaultBody(event: string): string {
  switch (event) {
    case "permission_required":
      return "Agent 需要您的授权许可"
    case "input_required":
      return "Agent 正在等待您的输入"
    case "run_completed":
      return "任务执行完成"
    case "run_failed":
      return "任务执行失败"
    case "run_cancelled":
      return "用户主动中断了任务"
    default:
      return `事件: ${event}`
  }
}

/**
 * 格式化结构化通知正文
 *
 * 输出格式：
 *   事件：权限请求
 *   会话：ses_abc1234
 *   详情：Agent 需要授权
 *   时间：2026-05-31 15:30:00
 */
export function formatBody(msg: Message): string {
  const now = new Date()
  const time = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
  const eventLabel = EVENT_LABELS[msg.event] ?? msg.event

  return [
    `事件：${eventLabel}`,
    `会话：${shortSession(msg.sessionID)}`,
    `时间：${time}`,
    `详情：${msg.body}`,
  ].join("\n")
}

/** 截断标题到指定长度 */
function shortTitle(title: string, maxLen = 20): string {
  if (title.length <= maxLen) return title
  return title.slice(0, maxLen - 1) + "…"
}

/**
 * 增强通知消息：注入会话上下文
 *
 * 上下文全部来自 `session.updated` 的 `info.title`（opencode 自动生成或用户输入），
 * `session.created` 的 `info.title` 可能是 "New session - ..." 占位符，不可靠，不再使用。
 *
 * - 标题：`[主题] 事件标签`（替换 `opencode - 事件标签`）
 * - 正文：在 `时间` 行前插入 `主题` 行
 *
 * @param msg 原始通知消息
 * @param sessionTopic 会话主题（来自 session.updated）
 * @returns 增强后的消息（原地修改并返回）
 */
export function enrich(msg: Message, sessionTopic?: string): Message {
  if (!sessionTopic) return msg

  const label = EVENT_LABELS[msg.event] ?? msg.event
  msg.title = `[${shortTitle(sessionTopic)}] ${label}`

  // 在"时间"行前插入"主题"行
  msg.body = msg.body.replace(/^(时间：.*)$/m, `主题：${sessionTopic}\n$1`)
  return msg
}
