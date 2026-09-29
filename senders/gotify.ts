import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import { stripInlineBold, bodyWithReplyHint } from "../text-format.js"

/**
 * Gotify 通知发送器
 *
 * POST {server}/message，用 A 开头 application token 认证。
 * 与 channels.custom_webhook 里的 Gotify 用法等价，但作为内置渠道，
 * 支持与 reply 回复能力共用同一 application（通知 + 回执）。
 *
 * 注意：Gotify 不支持通知内按钮，回复只能靠手机端发文本命令。
 */
export class GotifyNotifySender implements Sender {
  readonly name = "gotify"

  constructor(
    private readonly serverUrl: string,
    private readonly appToken: string,
    private readonly priority = 5,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  async send(msg: Message): Promise<void> {
    // Gotify 是纯文本渲染（message 字段不解析 markdown）：
    // 先补回复提示（否则用户拿到令牌却不知道命令语法），再剥掉粗体标记。
    const text = stripInlineBold(bodyWithReplyHint(msg))
    const res = await fetch(`${this.serverUrl}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gotify-Key": this.appToken,
      },
      body: JSON.stringify({
        title: msg.title,
        message: text,
        priority: this.priority,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`gotify returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
    }
  }
}
