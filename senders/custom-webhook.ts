import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { CustomWebhookChannelConfig } from "../config.js"

/**
 * 自定义 Webhook 发送器
 *
 * 支持任意 HTTP Webhook 服务，通过模板配置请求体。
 * 模板占位符: {{title}} {{body}} {{event}} {{agent}} {{sessionID}}
 *
 * Gotify 配置示例:
 * ```json
 * {
 *   "enabled": true,
 *   "url": "https://gotify.example.com/message",
 *   "method": "POST",
 *   "headers": { "X-Gotify-Key": "YOUR_APP_TOKEN" },
 *   "template": "{\"title\":\"{{title}}\",\"message\":\"{{body}}\",\"priority\":5}"
 * }
 * ```
 */
export class CustomWebhookSender implements Sender {
  readonly name = "custom_webhook"
  private config: CustomWebhookChannelConfig

  constructor(config: CustomWebhookChannelConfig) {
    this.config = config
  }

  async send(msg: Message): Promise<void> {
    const { url, method = "POST", headers = {}, template } = this.config

    if (!url) {
      throw new Error("custom_webhook: url not configured")
    }

    // 构造请求体
    let body: string | undefined
    if (template) {
      body = this.interpolate(template, msg)
    } else {
      // 默认 JSON 格式
      body = JSON.stringify({
        title: msg.title,
        message: msg.body,
        event: msg.event,
        agent: msg.agent,
      })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: method === "POST" ? body : undefined,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `custom_webhook returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      )
    }
  }

  /** 模板插值 */
  private interpolate(tpl: string, msg: Message): string {
    return tpl
      .replace(/\{\{title\}\}/g, this.escapeJson(msg.title))
      .replace(/\{\{body\}\}/g, this.escapeJson(msg.body))
      .replace(/\{\{event\}\}/g, this.escapeJson(msg.event))
      .replace(/\{\{agent\}\}/g, this.escapeJson(msg.agent))
      .replace(/\{\{sessionID\}\}/g, this.escapeJson(msg.sessionID))
  }

  /** 转义模板值中的特殊字符（防止破坏 JSON） */
  private escapeJson(s: string): string {
    return s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
  }
}
