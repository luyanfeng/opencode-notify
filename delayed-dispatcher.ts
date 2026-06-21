import type { Message } from "./message.js"
import type { Sender } from "./senders/types.js"
import { error, warn, info, debug } from "./log.js"
import { isTerminalOccluded, getSystemIdleMs } from "./terminator-detect.js"

/**
 * 远程延迟通知调度器
 *
 * 职责：
 * 1. 正常通知发出后，为指定渠道额外调度延迟推送
 * 2. 延迟期内用户活跃 → 取消该会话所有待发延迟通知
 * 3. 超时后发送，最多重复 remote_delay_max_count 次
 */

interface PendingEntry {
  /** 当前已发送次数 */
  count: number
  /** 定时器 ID，用于取消 */
  timeoutId: ReturnType<typeof setTimeout> | null
  /** 条目创建时间戳，用于防止立即取消的竞态 */
  createdAt: number
}

export class DelayedDispatcher {
  /**
   * 待发延迟通知
   * Map<sessionID, Map<channelName, PendingEntry>>
   */
  private pending: Map<string, Map<string, PendingEntry>> = new Map()

  constructor(
    /** 延迟毫秒数 */
    private delayMs: number,
    /** 最大重复次数 */
    private maxCount: number,
    /** 需要延迟推送的渠道名列表 */
    private channelNames: string[],
    /** 渠道名 → Sender 映射（已包含事件过滤） */
    private senders: Map<string, Sender>,
  ) {}

  /**
   * 调度延迟通知
   *
   * 在正常通知发出后调用，为 remote_delay_channels 中的渠道
   * 逐个调度延迟推送。同一会话同一渠道已有待发任务则跳过（不重复调度）。
   */
  schedule(msg: Message): void {
    if (this.channelNames.length === 0) return

    const sid = msg.sessionID
    if (!this.pending.has(sid)) {
      this.pending.set(sid, new Map())
    }

    const chMap = this.pending.get(sid)!
    for (const ch of this.channelNames) {
      // 该渠道已有待发延迟 → 跳过（不重复调度）
      if (chMap.has(ch)) continue

      chMap.set(ch, { count: 0, timeoutId: null, createdAt: Date.now() })
      this.scheduleOne(sid, ch, msg)
      info(`远程延迟: 已调度 会话=${sid} 渠道=${ch} 延迟=${this.delayMs}ms`)
      info(`[DIAG] schedule: msg.event=${msg.event} title=${msg.title?.slice(0, 40)}`)
    }
  }

  /**
   * 取消指定会话的所有待发延迟通知
   *
   * 在用户活跃事件或会话删除时调用。
   */
  /**
   * 取消指定会话的用户活动触发的待发延迟通知
   *
   * 保护规则：刚建立（< delayMs 的 1/4）的条目不取消，
   * 防止 opencode 在任务完成后的内部事件（如 tui.command.execute）
   * 竞态取消刚调度的延迟通知。
   */
  cancelForSession(sessionID: string): void {
    const chMap = this.pending.get(sessionID)
    if (!chMap) return

    const now = Date.now()
    const protectMs = Math.max(5000, this.delayMs / 4)  // 至少 5 秒，最多 delayMs/4

    const remaining: Array<[string, PendingEntry]> = []
    for (const [ch, entry] of chMap) {
      if (now - entry.createdAt < protectMs) {
        // 刚建立 → 跳过（不取消）
        remaining.push([ch, entry])
        debug(`远程延迟: 保护新条目 会话=${sessionID} 渠道=${ch} (已存活${now - entry.createdAt}ms < ${protectMs}ms)`)
      } else {
        // 已稳定存在 → 正常取消
        if (entry.timeoutId !== null) {
          clearTimeout(entry.timeoutId)
        }
      }
    }

    if (remaining.length === 0) {
      this.pending.delete(sessionID)
      info(`远程延迟: 已取消 会话=${sessionID}`)
    } else {
      // 仍有受保护条目，重建 map
      const newMap = new Map(remaining)
      this.pending.set(sessionID, newMap)
      info(`远程延迟: 部分取消 会话=${sessionID} (${remaining.length} 个条目受保护保留)`)
    }
  }

  /**
   * 等待指定会话的待发延迟任务数量
   * 用于测试/诊断
   */
  pendingCount(sessionID: string): number {
    return this.pending.get(sessionID)?.size ?? 0
  }

  /**
   * 清理所有待发任务（插件卸载时调用）
   */
  destroy(): void {
    for (const sessionID of this.pending.keys()) {
      this.cancelForSession(sessionID)
    }
  }

  /**
   * 将毫秒转换为人类可读的间隔描述
   * 例: 30_000 → "30秒", 120_000 → "2分钟", 3_600_000 → "60分钟"
   */
  private formatInterval(ms: number): string {
    const sec = Math.round(ms / 1000)
    if (sec < 60) return `${sec}秒`
    const min = Math.round(sec / 60)
    return `${min}分钟`
  }

  /**
   * 在通知正文追加或替换延迟推送标记
   *
   * 清除正文末尾已有的旧标记行，追加最新标记。
   * 标记格式：
   *   ─────────────────
   *   ⚠️ 延迟 第2/3次（下次约 15:31:00 / 2分钟后）
   */
  private markDelayBody(body: string, current: number, total: number, nextDelayMs: number): string {
    // 移除旧标记（从末尾 ─── 分隔线到最后）
    const clean = body.replace(/\n─{3,}[\s\S]*$/, "")
    if (current < total) {
      const next = new Date(Date.now() + nextDelayMs)
      const t = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}:${String(next.getSeconds()).padStart(2, "0")}`
      return `${clean}\n─────────────────\n⚠️ 延迟 第${current}/${total}次（下次约 ${t} / ${this.formatInterval(nextDelayMs)}后）`
    }
    // 最后一次推送，不显示下次时间
    return `${clean}\n─────────────────\n⚠️ 延迟 第${current}/${total}次（最终）`
  }

  /**
   * 根据已发送次数计算本次延迟
   *
   * 指数退避：base × 2^count，上限 10 分钟
   * count=0 → base, count=1 → base×2, count=2 → base×4, ...
   */
  private getDelayMs(count: number): number {
    const max = 600_000  // 10 分钟上限
    return Math.min(this.delayMs * Math.pow(2, count), max)
  }

  /**
   * 判断是否应取消延迟推送（用户已回到电脑前）
   *
   * 两层检测：
   *   1. isTerminalOccluded() === true → 用户在别的应用/子屏 → 不取消（发）
   *   2. 本屏可见（false/null）→ 查系统空闲时间：
   *       空闲时间 < 延迟窗口 → 用户有近期输入，已回来 → 取消
   *       空闲时间 >= 延迟窗口 → 用户一直闲置 → 不取消（发）
   *       无法检测空闲时间 → 保守继续发
   *
   * @returns true=应取消，false=应继续发送
   */
  private shouldCancel(sid: string): boolean {
    const occluded = isTerminalOccluded()
    info(`[DIAG] shouldCancel: occluded=${occluded} 会话=${sid}`)

    // 用户在别的窗口/子屏 → 肯定没看本终端，继续发
    if (occluded === true) {
      info(`[DIAG] shouldCancel: occluded=true → 不取消`)
      return false
    }

    // 本终端可能可见 → 查系统空闲时间判断用户是否真在
    const idleMs = getSystemIdleMs()
    info(`[DIAG] shouldCancel: idleMs=${idleMs} delayMs=${this.delayMs} 会话=${sid}`)

    if (idleMs !== null && idleMs < this.delayMs) {
      info(`远程延迟: 用户已回到电脑前（空闲${Math.round(idleMs / 1000)}秒 < 延迟${this.delayMs / 1000}秒），取消会话=${sid} 的延迟推送`)
      this.cancelForSession(sid)
      return true
    }

    // 空闲时间 >= 延迟窗口 或 无法检测 → 继续发
    if (idleMs !== null) {
      info(`[DIAG] shouldCancel: idleMs>=delayMs → 不取消, 继续发送 会话=${sid}`)
    } else {
      info(`[DIAG] shouldCancel: idleMs=null → 不取消, 继续发送 会话=${sid}`)
    }
    return false
  }

  /**
   * 调度单次延迟发送
   */
  private scheduleOne(sid: string, ch: string, msg: Message): void {
    const chMap = this.pending.get(sid)
    if (!chMap) return
    const entry = chMap.get(ch)
    if (!entry) return

    const currentDelay = this.getDelayMs(entry.count)

    entry.timeoutId = setTimeout(() => {
      try {
        entry.timeoutId = null

        info(`[DIAG] scheduleOne TIMEOUT FIRED 会话=${sid} 渠道=${ch} count=${entry.count} delayMs=${this.delayMs}`)

        // 判断用户是否在电脑前：窗口/子屏可见性 + 系统空闲时间
        if (this.shouldCancel(sid)) return

        // 在正文追加延迟标记（第几次 / 共几次 / 下次时间）
        const sendCount = entry.count + 1  // 1-based
        const nextDelay = this.getDelayMs(entry.count + 1)
        msg.body = this.markDelayBody(msg.body, sendCount, this.maxCount, nextDelay)

        // 发送延迟通知
        const sender = this.senders.get(ch)
        if (sender) {
          sender.send(msg).catch((err) => {
            error(`远程延迟推送失败 会话=${sid} 渠道=${ch}: ${err}`)
          })
          info(`远程延迟: 已推送 会话=${sid} 渠道=${ch}`)
        }

        // 检查是否需要继续重试
        entry.count++
        if (entry.count < this.maxCount) {
          this.scheduleOne(sid, ch, msg)
          debug(`远程延迟: 重试 ${entry.count}/${this.maxCount} 会话=${sid} 渠道=${ch} 下次延迟=${this.getDelayMs(entry.count)}ms`)
        } else {
          // 达到最大次数，清理
          chMap.delete(ch)
          if (chMap.size === 0) {
            this.pending.delete(sid)
          }
          info(`远程延迟: 已完成 会话=${sid} 渠道=${ch} (推送${entry.count}次)`)
        }
      } catch (e) {
        error(`远程延迟回调异常 会话=${sid} 渠道=${ch}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }, currentDelay)
  }
}
