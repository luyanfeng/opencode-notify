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
  /** 操作按钮（仅 ntfy 通知发送器会渲染为 Actions） */
  controlButtons?: import("./control/types.js").ControlButton[]
  /**
   * 可回复命令提示（仅 ntfy 渠道追加到正文末尾，帮助用户免记命令）。
   * 由 index.ts 按事件类型/选项数生成；其它渠道忽略。
   */
  replyHint?: string
  /**
   * 去重 key 覆盖（可选）。
   * 权限/提问每条都是**不同请求**（各带唯一令牌），用默认 key
   * `agent:event:sessionID` 会把同会话 60s 内的第 2 条提问吞掉——
   * 那是用户必须看到的请求。故权限/提问用含 requestID 的独立 key；
   * 其余事件沿用默认。
   */
  dedupeKey?: string
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
 * 输出格式（key 列加粗，ntfy markdown 渲染）：
 *   **事件：**权限请求
 *   **会话：**ses_abc1234
 *   **详情：**Agent 需要授权
 *   **时间：**2026-05-31 15:30:00
 */
export function formatBody(msg: Message): string {
  const now = new Date()
  const time = now.toLocaleString("zh-CN", { hour12: false })
  const eventLabel = EVENT_LABELS[msg.event] ?? msg.event

  // key 列统一 **加粗**，且 `**` 闭合后必须跟空格/标点/换行：CommonMark 强调规则要求
  // 「**」后直接跟字母/数字/汉字（如 `**会话：**ses`）时闭合判定失败、不渲染粗体
  //（实测「事件：」粗体（值以「开头）但「会话/时间/输入」不粗）。ntfy 用 goldmark 渲染，
  //  严格遵守该规则，故统一写成 `**key：** 值`。不支持 markdown 的渠道只是多个空格。
  return [
    `**事件：**「${defaultBody(msg.event)}」`,
    `**会话：** ${shortSession(msg.sessionID)}`,
    `**时间：** ${time}`,
    `**输入：** ${msg.body}`,
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
 * - 正文：`用户输入` 追加到 `详情` 行末尾，`助手回复` 追加在最后
 *
 * @param msg 原始通知消息
 * @param sessionTopic 会话主题（来自 session.updated）
 * @param userPrompt 用户输入内容（来自 chat.message hook）
 * @param assistantSummary 助手回复摘要（来自 chat.message hook）
 * @returns 增强后的消息（原地修改并返回）
 */
export function enrich(msg: Message, sessionTopic?: string, userPrompt?: string, assistantSummary?: string): Message {
  const label = EVENT_LABELS[msg.event] ?? msg.event

  if (userPrompt) {
    msg.title = `[${shortTitle(userPrompt, 16)}] ${label}`
    msg.body = msg.body.replace(/^\*\*输入：\*\*(.+)$/m, `**输入：** ${shortTitle(userPrompt, 80)}`)
  }

  if (assistantSummary) {
    msg.body += `\n**输出：** ${shortTitle(assistantSummary, 500)}`
  }

  if (sessionTopic) {
    msg.body = msg.body.replace(/^(\*\*时间：\*\*.*)$/m, `**主题：** ${sessionTopic}\n$1`)
  }

  return msg
}
