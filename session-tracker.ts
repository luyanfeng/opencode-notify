/**
 * 会话状态追踪器
 *
 * 跟踪 opencode 每个会话的用户活跃状态，
 * 用于会话感知的通知抑制（用户在操作某会话时跳过部分通知）。
 *
 * 状态更新事件：
 *   message.updated / permission.replied / question.replied
 *   command.executed / tui.command.execute
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
      })
    }
  }

  /** 判断会话是否为子会话（background task） */
  isBackground(sessionID: string): boolean {
    if (sessionID === "unknown") return false
    const info = this.sessions.get(sessionID)
    return info ? isBackgroundSession(info) : false
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

  /** 获取用户提示词 */
  getUserPrompt(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.userPrompt
  }

  /** 获取会话主题 */
  getSessionTopic(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.sessionTopic
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

  /** 当前追踪的会话数（用于调试） */
  get size(): number {
    return this.sessions.size
  }
}
