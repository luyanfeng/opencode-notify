import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { FeishuChannelConfig } from "../config.js"

/**
 * 飞书 自定义机器人 Webhook 发送器
 *
 * 文档: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 *
 * 配置示例:
 * ```json
 * {
 *   "enabled": true,
 *   "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
 * }
 * ```
 *
 * 消息格式: 卡片消息 (interactive)
 * 包含标题、正文、分割线、脚注
 */
export class FeishuSender implements Sender {
  readonly name = "feishu"
  private config: FeishuChannelConfig

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }

  async send(msg: Message): Promise<void> {
    const { webhook_url } = this.config

    if (!webhook_url) {
      throw new Error("feishu: webhook_url not configured")
    }

    const body = JSON.stringify({
      msg_type: "interactive",
      card: {
        header: {
          title: {
            tag: "plain_text",
            content: msg.title,
          },
        },
        elements: [
          {
            tag: "markdown",
            content: msg.body,
          },
        ],
      },
    })

    const response = await fetch(webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `feishu returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      )
    }
  }
}
