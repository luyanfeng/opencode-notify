import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { ControlButton } from "../control/types.js"

/**
 * ntfy 通知发送器（支持操作按钮）
 *
 * 与 custom_webhook 的区别：本发送器能把 Message.controlButtons 渲染成
 * ntfy 的 Actions —— 手机收到通知后**点按按钮即自动发回命令**（http 动作）
 * 或**把命令模板复制到剪贴板**（copy 动作）。
 *
 * 合并单话题时，发布的通知会带 `tags:[botTag]` 标记，插件订阅端据此忽略自身消息防回环。
 *
 * 采用 ntfy 结构化 JSON 发布（topic/title/message/priority/actions/tags 全在 body）：
 * 避免把中文标题/按钮文案放进 HTTP header（Bun fetch 拒绝非 ASCII header 值）。
 */
export class NtfyNotifySender implements Sender {
  readonly name = "ntfy"

  constructor(
    private readonly serverUrl: string,
    private readonly notifyTopic: string,
    private readonly commandTopic: string,
    private readonly token?: string,
    /** 默认优先级（权限通知会额外提升，见 send） */
    private readonly defaultPriority = 3,
    /** 按钮发出的命令消息优先级（可选；不设则用 ntfy 默认） */
    private readonly commandPriority?: number,
    /** 插件自身消息标记 tag（合并单话题时用于防回环） */
    private readonly botTag?: string,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  async send(msg: Message): Promise<void> {
    // ntfy 的 JSON 发布走根路径 "/"（topic 在 body 里）；
    // POST 到 /topic 时 body 会被当纯文本 message，导致 JSON 串原样显示
    const url = `${this.serverUrl}/`
    const priority = msg.event === "permission_required" ? Math.max(5, this.defaultPriority) : this.defaultPriority
    const text = msg.replyHint ? `${msg.body}\n${msg.replyHint}` : msg.body
    const payload: Record<string, unknown> = {
      topic: this.notifyTopic,
      title: msg.title,
      message: text,
      priority,
    }
    if (this.botTag) payload.tags = [this.botTag]
    const actions = this.buildActions(msg.controlButtons)
    if (actions.length > 0) payload.actions = actions

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`ntfy returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
    }
  }

  /**
   * 生成结构化 actions；无按钮返回空数组。
   * - http 动作（有 body）：POST 回命令话题，插件读取执行
   * - copy 动作（有 value）：写入剪贴板，用户粘贴补写后发送
   * ntfy 服务端硬限每条消息最多 3 个 action。
   */
  private buildActions(buttons?: ControlButton[]): unknown[] {
    if (!buttons || buttons.length === 0) return []
    const cmdUrl = `${this.serverUrl}/${encodeURIComponent(this.commandTopic)}`
    const httpHeaders: Record<string, string> = {}
    if (this.token) httpHeaders.Authorization = `Bearer ${this.token}`
    if (this.commandPriority !== undefined) httpHeaders.Priority = String(this.commandPriority)

    return buttons.slice(0, 3).map((b) => {
      if (b.value !== undefined) {
        // copy：不 clear，用户补写正文时仍能看到通知作参照
        return { action: "copy", label: b.label, value: b.value, clear: false }
      }
      return {
        action: "http",
        label: b.label,
        url: cmdUrl,
        method: "POST",
        headers: httpHeaders,
        body: b.body ?? "",
        clear: true,
      }
    })
  }
}