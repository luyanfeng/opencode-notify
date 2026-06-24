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
  /** 用户最后一次输入内容 */
  userPrompt?: string
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
 */
export function formatTitle(event: string): string {
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
  const time = now.toLocaleString("zh-CN", { hour12: false })
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
 * - 标题：`[用户输入前16字] 事件标签`（有用户输入时替换 `opencode - 事件标签`）
 * - 正文：`用户输入` 追加到 `详情` 行末尾
 *
 * @param msg 原始通知消息
 * @param sessionTopic 会话主题（来自 session.updated）
 * @param userPrompt 用户输入内容（来自 chat.message hook）
 * @returns 增强后的消息（原地修改并返回）
 */
export function enrich(msg: Message, sessionTopic?: string, userPrompt?: string): Message {
  const label = EVENT_LABELS[msg.event] ?? msg.event

  if (userPrompt) {
    msg.title = `[${shortTitle(userPrompt, 16)}] ${label}`
    msg.body = msg.body.replace(/^(详情：.*)$/m, `$1 — ${shortTitle(userPrompt, 80)}`)
  }

  if (sessionTopic) {
    msg.body = msg.body.replace(/^(时间：.*)$/m, `主题：${sessionTopic}\n$1`)
  }

  return msg
}
