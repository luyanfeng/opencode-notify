import { error } from "../log.js"

/**
 * ntfy 命令通道的共享工具（poll / stream 两种传输共用）
 */

/** 插件自身消息的默认标记 tag（合并单话题时用于防回环） */
export const DEFAULT_BOT_TAG = "opencode"

/** 回执消息标题（固定值；订阅端据此识别"这是回执，绝不是命令"） */
export const RECEIPT_TITLE = "opencode 回执"

/** ntfy NDJSON 单行消息（stream 与 poll 同构） */
export interface NtfyMessage {
  id: string
  /** Unix 秒 */
  time?: number
  /** open | keepalive | message | message_delete | message_clear | poll_request */
  event?: string
  topic?: string
  message?: string
  title?: string
  priority?: number
  /** 消息标签（string array）；插件自身消息据此识别 */
  tags?: string[]
}

/**
 * 是否为插件自身发布的消息（含 bot_tag）。
 * 合并单话题时，订阅端必须忽略自身消息，否则会把通知/回执当命令解析（回环）。
 */
export function isBotMessage(tags: string[] | undefined, botTag: string): boolean {
  return Array.isArray(tags) && tags.includes(botTag)
}

/**
 * 是否为"插件自己生成、绝不能当命令处理"的消息。
 *
 * 两道防线（防回环自激）：
 *   1. tag 标记：发布时带 `bot_tag`，订阅端按 tag 过滤（正常路径）。
 *   2. 标题兜底：回执标题固定为 `RECEIPT_TITLE`；即使 tag 缺失/配置错误，
 *      也绝不把回执当命令解析——否则「回执 → 未识别 → 再回执 → …」会自激。
 */
export function isSelfMessage(m: { title?: string; tags?: string[] }, botTag?: string): boolean {
  if (botTag && isBotMessage(m.tags, botTag)) return true
  return m.title === RECEIPT_TITLE
}

/** 受保护话题的 Bearer 认证头 */
export function ntfyAuthHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 去除基址尾斜杠 */
export function normalizeBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "")
}

/** 构造订阅 URL；`since` 仅在有值时带上（流式不带 since = 只收新消息） */
export function ntfyJsonUrl(serverUrl: string, topic: string, since: string | null, poll: boolean): string {
  const qs = new URLSearchParams()
  if (poll) qs.set("poll", "1")
  if (since) qs.set("since", since)
  const query = qs.toString()
  return `${normalizeBase(serverUrl)}/${encodeURIComponent(topic)}/json${query ? `?${query}` : ""}`
}

/**
 * 发布回执到通知话题（与通知共用话题），附低优先级与 bot_tag。
 * 失败仅记日志，不抛出（回执不应影响命令主流程）。
 */
export async function publishNtfyReceipt(
  cfg: { serverUrl: string; notifyTopic?: string; token?: string; receiptPriority: number; botTag?: string },
  text: string,
): Promise<void> {
  if (!cfg.notifyTopic) return
  try {
    const payload: Record<string, unknown> = {
      topic: cfg.notifyTopic,
      title: RECEIPT_TITLE,
      message: text,
      priority: cfg.receiptPriority,
    }
    // 合并单话题时必须带 bot_tag，否则回执会被插件自己读成命令
    if (cfg.botTag) payload.tags = [cfg.botTag]
    // ntfy 的 JSON 发布走根路径 "/"（topic 在 body 里）
    const res = await fetch(`${normalizeBase(cfg.serverUrl)}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ntfyAuthHeaders(cfg.token),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) error(`control[ntfy]: 回执发布失败 HTTP ${res.status}`)
  } catch (e) {
    error(`control[ntfy]: 回执发布异常 ${e instanceof Error ? e.message : String(e)}`)
  }
}
