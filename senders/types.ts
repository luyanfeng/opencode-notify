import type { Message } from "../message.js"

/** 通知发送器接口 */
export interface Sender {
  readonly name: string
  send(msg: Message): Promise<void>
}
