import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { CustomWebhookChannelConfig } from "../config.js"
import { stripInlineBold, bodyWithReplyHint } from "../text-format.js"

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

    // 自定义 webhook 目标不可知（可能是飞书/钉钉等 markdown 型，也可能是纯文本型），
    // 保守按纯文本处理：先补回复提示（否则用户拿到令牌却不知道命令语法），再剥粗体标记。
    // 模板插值与默认 JSON 两处复用同一份文本，只算一次。
    const text = stripInlineBold(bodyWithReplyHint(msg))
    const sendMsg: Message = { ...msg, body: text }

    // 构造请求体
    let body: string | undefined
    if (template) {
      body = this.interpolate(template, sendMsg)
    } else {
      // 默认 JSON 格式
      body = JSON.stringify({
        title: msg.title,
        message: text,
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
    const vars: Record<string, string> = {
      title: msg.title,
      body: msg.body,
      event: msg.event,
      agent: msg.agent,
      sessionID: msg.sessionID,
    }
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = vars[key]
      return val !== undefined ? JSON.stringify(val).slice(1, -1) : `{{${key}}}`
    })
  }

  /** 转义模板值中的特殊字符（防止破坏 JSON） */
  private escapeJson(s: string): string {
    return JSON.stringify(s).slice(1, -1)
  }
}
