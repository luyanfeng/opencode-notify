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
  session_idle: "会话空闲",
}

/**
 * 格式化通知标题
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
    default:
      return `事件: ${event}`
  }
}
