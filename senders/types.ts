import type { Message } from "../message.js"

/** 通知发送器接口 */
export interface Sender {
  readonly name: string
  send(msg: Message): Promise<void>
}

/**
 * 带事件过滤的 Sender 包装器
 *
 * 包装一个 Sender，只有 msg.event 在 events 列表中时才转发。
 * events 为 undefined/空时继承全局（不过滤）。
 */
export class FilteredSender implements Sender {
  readonly name: string
  private sender: Sender
  private events: Set<string> | undefined

  constructor(sender: Sender, events?: string[]) {
    this.name = `${sender.name}[filtered]`
    this.sender = sender
    this.events = events && events.length > 0 ? new Set(events) : undefined
  }

  async send(msg: Message): Promise<void> {
    if (this.events && !this.events.has(msg.event)) {
      return // 事件不在该渠道订阅列表中，跳过
    }
    return this.sender.send(msg)
  }
}
