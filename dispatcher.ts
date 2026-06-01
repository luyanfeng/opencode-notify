import type { Message } from "./message.js"
import type { Sender } from "./senders/types.js"
import { FileStore } from "./store.js"
import { error, warn, info, debug } from "./log.js"

/**
 * 通知分发器
 *
 * 职责：
 * 1. 去重检查（通过 Store）
 * 2. 遍历所有已启用的 Sender 发送通知
 * 3. 发送成功后标记状态
 */
export class Dispatcher {
  private store: FileStore
  private windowSec: number
  private senders: Sender[]

  constructor(
    store: FileStore,
    windowSec: number,
    senders: Sender[],
  ) {
    this.store = store
    this.windowSec = windowSec
    this.senders = senders
  }

  async dispatch(msg: Message): Promise<void> {
    if (this.senders.length === 0) {
      warn(`没有启用的通知渠道，跳过: ${msg.event} 会话=${msg.sessionID}`)
      return
    }

    const now = Date.now()
    const key = this.store.buildKey(msg.agent, msg.event, msg.sessionID)

    // 去重检查 + 预留发送时隙
    const allowed = this.store.reserveSend(key, this.windowSec, now)
    if (!allowed) {
      debug(`去重命中，跳过: ${key}`)
      return
    }

    info(`分发通知: agent=${msg.agent} event=${msg.event} 会话=${msg.sessionID} 渠道数=${this.senders.length}`)

    // 并发发送到所有渠道
    const results = await Promise.allSettled(
      this.senders.map((s) => s.send(msg)),
    )

    // 所有都成功 → 标记已发送
    const allSuccess = results.every(
      (r) => r.status === "fulfilled",
    )

    if (allSuccess) {
      this.store.markSent(key, now)
      debug(`通知发送成功: ${key}`)
    } else {
      // 有失败 → 释放预留
      this.store.clearReservation(key)
      let failCount = 0
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status === "rejected") {
          failCount++
          error(`渠道 ${this.senders[i].name} 发送失败: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
      }
      warn(`通知部分失败: ${key} (${failCount}/${this.senders.length} 个渠道失败)`)
    }
  }
}
