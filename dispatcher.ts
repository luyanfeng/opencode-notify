import type { Message } from "./message.js"
import type { Sender } from "./senders/types.js"
import { FileStore } from "./store.js"
import { error, warn, info, debug } from "./log.js"
import { clampBodyBytes, NOTIFY_BODY_MAX_BYTES } from "./text-format.js"

/**
 * 通知分发器
 *
 * 职责：
 * 1. 去重检查（通过 Store）
 * 2. 遍历所有已启用的 Sender 发送通知
 * 3. 发送成功后标记状态
 *
 * 并发控制：最多同时发送 3 个渠道，避免连接数激增。
 * 去重策略：至少一个渠道成功即标记去重（非全部成功），
 * 避免单个渠道故障导致其他渠道重复发送。
 */
export class Dispatcher {
  private store: FileStore
  private windowSec: number
  private senders: Sender[]
  /** 最大并发发送数 */
  private maxConcurrency = 3

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
    // 权限/提问类通知用含 requestID 的独立去重 key（每条请求都必须送达）；
    // 其余事件沿用 agent:event:sessionID（防重复骚扰）。
    const key = msg.dedupeKey ?? this.store.buildKey(msg.agent, msg.event, msg.sessionID)

    // 去重检查 + 预留发送时隙
    const allowed = this.store.reserveSend(key, this.windowSec, now)
    if (!allowed) {
      debug(`去重命中，跳过: ${key}`)
      return
    }

    info(`分发通知: agent=${msg.agent} event=${msg.event} 会话=${msg.sessionID} 渠道数=${this.senders.length}`)

    // 并发发送（限制最大并发数）
    const results = await this.sendWithConcurrency(msg)

    // 至少一个渠道成功 → 标记已发送
    const anySuccess = results.some((r) => r.status === "fulfilled")

    if (anySuccess) {
      this.store.markSent(key, now)
      debug(`通知发送成功: ${key}`)
    } else {
      this.store.clearReservation(key)
    }

    // 记录失败详情
    let failCount = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "rejected") {
        failCount++
        error(`渠道 ${this.senders[i].name} 发送失败: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      }
    }
    if (failCount > 0) {
      warn(`通知部分失败: ${key} (${failCount}/${this.senders.length} 个渠道失败)`)
    }
  }

  /**
   * 带并发限制的发送
   * 将发送器分批，每批最多 maxConcurrency 个并行
   */
  private async sendWithConcurrency(msg: Message): Promise<PromiseSettledResult<void>[]> {
    const results: PromiseSettledResult<void>[] = new Array(this.senders.length)
    const out = this.clampBody(msg)

    for (let i = 0; i < this.senders.length; i += this.maxConcurrency) {
      const batch = this.senders.slice(i, i + this.maxConcurrency)
      const batchResults = await Promise.allSettled(
        batch.map((s) => s.send(out)),
      )
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j]
      }
    }

    return results
  }

  /**
   * 发送前钳制正文长度
   *
   * ntfy 消息上限 4095 字节、企业微信 4096 字节，超限会被平台直接拒收或静默截断
   * （后者更糟：用户看到半截通知，连令牌行都可能没了）。这里统一按 3600 字节兜底。
   *
   * ⚠️ 返回**浅拷贝**而不是就地改 msg.body：index.ts 把同一个 msg 对象先交给
   * dispatch() 再交给 delayedDispatcher.schedule()，而 DelayedDispatcher 会
   * 原地改写 msg.body（markDelayBody 追加延迟标记）。就地钳制会污染延迟推送的内容，
   * 也会让两次发送的正文互相干扰。
   *
   * 去重不受影响：去重 key 在 dispatch() 开头就用 msg.agent/event/sessionID 算好
   * （store.buildKey / msg.dedupeKey），与 body 内容无关；钳制只影响送给渠道的文本。
   */
  private clampBody(msg: Message): Message {
    const originalBytes = Buffer.byteLength(msg.body, "utf8")
    const clamped = clampBodyBytes(msg.body, NOTIFY_BODY_MAX_BYTES)
    if (!clamped.truncated) return msg

    const afterBytes = Buffer.byteLength(clamped.text, "utf8")
    warn(
      `通知正文超长，已截断: event=${msg.event} 会话=${msg.sessionID} ` +
      `${originalBytes}字节 → ${afterBytes}字节`,
    )
    if (clamped.tokenTruncated) {
      // 极端情况：尾部（令牌行及其后）本身就超限，令牌被硬截断 → 这条通知无法回复
      error(
        `通知正文严重超长，令牌行被硬截断（该通知将无法回复）: event=${msg.event} ` +
        `会话=${msg.sessionID} ${originalBytes}字节 → ${afterBytes}字节`,
      )
    }
    return { ...msg, body: clamped.text }
  }
}
