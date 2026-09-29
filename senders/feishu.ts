import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { FeishuChannelConfig } from "../config.js"
import { bodyWithReplyHint } from "../text-format.js"

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
            // 飞书卡片会渲染 markdown：正文加粗标记要存活（escapeMarkdown 已不转义 `*`），
            // 但 replyHint 必须一并带上 —— 否则本渠道用户只看到「令牌：oc-xxxx」却不知道命令语法。
            content: this.escapeMarkdown(bodyWithReplyHint(msg)),
          },
        ],
      },
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
        `feishu returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      )
    }
  }

  /**
   * 转义 Markdown 特殊字符
   *
   * ⚠️ 故意**不转义 `*`**：正文里的 `**事件：**`、`**令牌：**`、`**1 允许**`
   * 是我们自己的加粗 key 行，转义后飞书会显示成字面 `\*\*事件：\*\*`，
   * 整张卡片全是转义星号（`escapeMarkdown` 原本是给「用户内容当 markdown 注入」
   * 兜底的，但它把**我们生成的**标记也一起干掉了）。
   * 代价：正文里模型输出偶发的单个 `*` 会被飞书当成强调起始符（显示观感问题，
   * 不是安全问题）。其余 `` ` ``、`_`、`#`、`]` 保持转义（行为不变）。
   */
  private escapeMarkdown(s: string): string {
    return s.replace(/([_`#\]])/g, "\\$1")
  }
}
