/**
 * 会话状态追踪器
 *
 * 跟踪 opencode 每个会话的用户活跃状态，
 * 用于会话感知的通知抑制（用户在操作某会话时跳过部分通知）。
 *
 * 状态更新事件：
 *   session.inbox.enqueued / permission.replied / form.replied
 *   tui.command.execute
 *
 * 生命周期事件：
 *   session.created / session.deleted
 */

import { warn } from "./log.js"

export interface SessionInfo {
  sessionID: string
  /** 用户最后操作时间戳 */
  lastActivity: number
  /** 会话创建时间 */
  createdAt: number
  /** 父会话 ID，存在则表示是子会话（background task） */
  parentID?: string
  /** 用户输入的问题/任务描述（创建时捕获） */
  userPrompt?: string
  /** opencode 自动生成的会话主题（session.updated 时更新） */
  sessionTopic?: string
  /** 助手最后一段回复摘要 */
  assistantSummary?: string
  /** 当前助手消息的分桶累积（key=messageID），用于通知"输出"字段 */
  assistantBucket?: AssistantBucket
  /** 会话状态：busy | idle | retry | deleted */
  status?: string
}

/**
 * 助手回复的分桶累积
 *
 * 按 messageID 分桶：只累积**当前这条助手消息**的完整文本（流式 part 逐段追加），
 * 新 messageID 出现即换桶——避免多条消息混进一个滚动窗导致"输出"从随机断点开始。
 * 思考内容是独立的 reasoning part（`type: "reasoning"`），本桶只收 text part，天然不含思考。
 */
export interface AssistantBucket {
  messageID: string
  /** 累积文本（超上限从头部丢弃，保留尾部） */
  text: string
  /** 是否被截断过（用于展示提示） */
  truncated: boolean
}

/** 分桶累积上限（**UTF-8 字节**，保留尾部）。ntfy 服务端消息硬限 4095 字节（实测 4096 报 500），
 *  预留 ~1KB 给 title/tags/提示行等开销；中文 3 字节/字 → 约 1024 个中文字。 */
const BUCKET_MAX_BYTES = 3072

/** 按 UTF-8 字节截断保留尾部（超限丢弃头部），返回 {text, truncated} */
function tailByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, "utf8")
  if (total <= maxBytes) return { text, truncated: false }
  // 从头部逐字符丢弃直到字节数达标（Buffer.from 整串代价可接受：桶最大 3KB+一个 part）
  let s = text
  while (Buffer.byteLength(s, "utf8") > maxBytes) {
    s = s.slice(1)
  }
  return { text: s, truncated: true }
}

export function isBackgroundSession(info: SessionInfo): boolean {
  return !!info.parentID
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000  // 5 分钟

export class SessionTracker {
  private sessions = new Map<string, SessionInfo>()
  private staleTimeoutMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /**
   * @param staleTimeoutMs 会话无操作自动淘汰阈值（默认 10 分钟）
   */
  constructor(staleTimeoutMs = 600_000) {
    this.staleTimeoutMs = staleTimeoutMs
    this.startCleanupTimer()
  }

  // ============ 对外接口 ============

  /**
   * 检查某会话在指定超时窗口内是否有用户活动
   * @returns true = 用户正在操作，应抑制可抑制事件
   */
  isSessionActive(sessionID: string, activityTimeoutMs: number): boolean {
    if (sessionID === "unknown") return false
    const info = this.sessions.get(sessionID)
    if (!info) return false
    return Date.now() - info.lastActivity < activityTimeoutMs
  }

  // ============ 事件更新 ============

  /** 标记用户在该会话中有操作 */
  markActivity(sessionID: string): void {
    if (sessionID === "unknown") return
    this.lazyCleanup()
    const existing = this.sessions.get(sessionID)
    if (existing) {
      existing.lastActivity = Date.now()
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
      })
    }
  }

  /** 注册新会话 */
  register(sessionID: string, parentID?: string, userPrompt?: string): void {
    if (sessionID === "unknown") return
    const existing = this.sessions.get(sessionID)
    if (existing) {
      if (parentID) existing.parentID = parentID
      if (userPrompt) existing.userPrompt = userPrompt
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        parentID,
        userPrompt,
        status: "busy",  // 新创建的会话默认为忙碌
      })
    }
  }

  /** 判断会话是否为子会话（background task） */
  isBackground(sessionID: string): boolean {
    if (sessionID === "unknown") return false
    const info = this.sessions.get(sessionID)
    return info ? isBackgroundSession(info) : false
  }

  /** 补记父子关系（兜底：session.created 未带 parentID 时从 session.updated 记录） */
  setParent(sessionID: string, parentID: string): void {
    if (sessionID === "unknown" || !parentID) return
    const existing = this.sessions.get(sessionID)
    if (existing) {
      existing.parentID = parentID
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        parentID,
      })
    }
  }

  /** 更新会话状态（来自 session.status / session.idle） */
  updateStatus(sessionID: string, status: string): void {
    if (sessionID === "unknown" || !status) return
    const info = this.sessions.get(sessionID)
    if (info) info.status = status
  }

  /**
   * 检查某会话是否有活跃子会话
   * 活跃 = 状态为 busy/created（尚未 idle 或 deleted）
   */
  hasActiveChildren(sessionID: string): boolean {
    if (sessionID === "unknown") return false
    for (const [, info] of this.sessions) {
      if (info.parentID === sessionID) {
        const st = info.status
        // 未收到过 status 事件的子会话视为活跃（刚创建还在跑）
        if (!st || (st !== "idle" && st !== "deleted")) return true
      }
    }
    return false
  }

  /** 更新会话主题（opencode 自动生成，来自 session.updated） */
  updateTopic(sessionID: string, topic: string): void {
    if (sessionID === "unknown" || !topic) return
    const existing = this.sessions.get(sessionID)
    if (existing) {
      existing.sessionTopic = topic
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        sessionTopic: topic,
      })
    }
  }

  /** 获取会话主题 */
  getSessionTopic(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.sessionTopic
  }

  /** 设置助手回复摘要 */
  setAssistantSummary(sessionID: string, summary: string): void {
    if (sessionID === "unknown" || !summary) return
    const existing = this.sessions.get(sessionID)
    if (existing) {
      existing.assistantSummary = summary
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        assistantSummary: summary,
      })
    }
  }

  /**
   * 累积助手回复文本（按 messageID 分桶，保留尾部）
   *
   * 流式 part 逐段到达：同 messageID → 追加；新 messageID → 换桶（旧的丢弃）。
   * 超过桶字节上限从头部丢弃（truncated 标记），保证通知取到的是
   * "最后一条回复"的连续尾部，而非多条消息拼接的随机断点。
   */
  appendAssistantText(sessionID: string, messageID: string, text: string): void {
    if (sessionID === "unknown" || !messageID || !text) return
    const existing = this.sessions.get(sessionID)
    if (!existing) return
    let bucket = existing.assistantBucket
    if (!bucket || bucket.messageID !== messageID) {
      bucket = { messageID, text: "", truncated: false }
      existing.assistantBucket = bucket
    }
    let merged = bucket.text + text
    const t = tailByBytes(merged, BUCKET_MAX_BYTES)
    bucket.text = t.text
    if (t.truncated) bucket.truncated = true
  }

  /** 获取当前助手消息的累积文本（尾部，截断过则加省略前缀；前缀计入字节预算） */
  getAssistantText(sessionID: string): string | undefined {
    const bucket = this.sessions.get(sessionID)?.assistantBucket
    if (!bucket?.text) return undefined
    if (!bucket.truncated) return bucket.text
    // 前缀替换尾部 3 字节（"…"占 3 字节），保证整体不超桶上限
    const body = tailByBytes(bucket.text, BUCKET_MAX_BYTES - Buffer.byteLength("…", "utf8")).text
    return "…" + body
  }

  /** 用户新输入时冻结当前助手回复（截取最后一段非工具输出） */
  freezeAssistantSummary(sessionID: string): void {
    const existing = this.sessions.get(sessionID)
    if (!existing?.assistantSummary) return
    // 取最后 500 字作为摘要
    const s = existing.assistantSummary
    existing.assistantSummary = s.length > 500 ? "…" + s.slice(-500) : s
  }

  /** 获取助手回复摘要 */
  getAssistantSummary(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.assistantSummary
  }

  /** 设置用户输入内容 */
  setUserPrompt(sessionID: string, prompt: string): void {
    if (sessionID === "unknown" || !prompt) return
    const existing = this.sessions.get(sessionID)
    if (existing) {
      existing.userPrompt = prompt
    } else {
      this.sessions.set(sessionID, {
        sessionID,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        userPrompt: prompt,
      })
    }
  }

  /** 获取用户输入内容 */
  getUserPrompt(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.userPrompt
  }

  /** 移除会话 */
  remove(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  // ============ 内部 ============

  /** 惰性清除 — 每次操作时顺带清理少数过期条目 */
  private lazyCleanup(): void {
    const cutoff = Date.now() - this.staleTimeoutMs
    // 每次随机检查最多 8 条（避免大 Map 遍历性能开销）
    let checked = 0
    for (const [id, info] of this.sessions) {
      if (checked >= 8) break
      if (info.lastActivity < cutoff) this.sessions.delete(id)
      checked++
    }
  }

  /** 全量清理 */
  private fullCleanup(): void {
    const cutoff = Date.now() - this.staleTimeoutMs
    for (const [id, info] of this.sessions) {
      if (info.lastActivity < cutoff) this.sessions.delete(id)
    }
  }

  /** 启动定时清理 */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => this.fullCleanup(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  /** 销毁（进程退出时调用） */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    const count = this.sessions.size
    this.sessions.clear()
    if (count > 0) {
      warn(`会话追踪器销毁，清理 ${count} 个未过期会话`)
    }
  }


}
