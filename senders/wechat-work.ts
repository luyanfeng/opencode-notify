import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { WechatWorkChannelConfig } from "../config.js"

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

    // 构造 markdown 内容
    const content = [
      `**${msg.title}**`,
      "",
      msg.body,
      `> 会话: ${msg.sessionID}`,
    ].join("\n")

    const body = JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    })

    const response = await fetch(webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `wechat_work returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      )
    }
  }
}
