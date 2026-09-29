import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { WechatWorkChannelConfig } from "../config.js"
import { bodyWithReplyHint } from "../text-format.js"

/**
 * 企业微信 群机器人 Webhook 发送器
 *
 * 文档: https://developer.work.weixin.qq.com/document/path/99110
 *
 * 配置示例:
 * ```json
 * {
 *   "enabled": true,
 *   "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
 * }
 * ```
 *
 * 消息格式: Markdown
 * 支持: # 标题、**粗体**、[链接](url)、> 引用、- 列表
 */
export class WechatWorkSender implements Sender {
  readonly name = "wechat_work"
  private config: WechatWorkChannelConfig

  constructor(config: WechatWorkChannelConfig) {
    this.config = config
  }

  async send(msg: Message): Promise<void> {
    const { webhook_url } = this.config

    if (!webhook_url) {
      throw new Error("wechat_work: webhook_url not configured")
    }

    // 构造 markdown 内容（msg.body 已包含事件/会话/详情/时间/延迟标记）
    // 企业微信渲染 markdown → **粗体**必须保留，不做 stripInlineBold。
    // 追加 replyHint：只有 ntfy 自带提示，缺了它用户收到「令牌：oc-xxxx」也不知道命令语法。
    const content = [
      `**${msg.title}**`,
      "",
      bodyWithReplyHint(msg),
    ].join("\n")

    const body = JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    let response: Response
    try {
      response = await fetch(webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `wechat_work returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      )
    }
  }
}
