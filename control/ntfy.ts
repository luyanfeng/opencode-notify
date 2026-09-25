import type { CommandProvider, RawCommandMessage } from "./types.js"
import { PollLoop, parseRetryAfter, type TickOutcome } from "./poll-loop.js"
import { debug, error } from "../log.js"
import { ntfyAuthHeaders, ntfyJsonUrl, publishNtfyReceipt, isSelfMessage, type NtfyMessage } from "./ntfy-common.js"

/**
 * ntfy 命令通道（短轮询）
 *
 * 读取：GET {base}/{commandTopic}/json?poll=1[&since=<lastId>]，NDJSON，每行一条。
 *   只处理 event === "message"。首次轮询不带 since，记录最后一条 id 作为游标并跳过。
 *   合并单话题时按 `botTag` 过滤插件自身消息（游标仍推进）。
 * 回执：POST {base}/（与通知共用话题），body 即正文，附低优先级与 bot_tag。
 *
 * 说明：默认传输为流式（见 ntfy-stream.ts）；本类作为 `reply.transport: poll`
 * 的兼容/兜底实现（例如服务端/中间层不允许长连接时）。
 *
 * 错误处理：401/403 认证失败按连续次数熔断（停止轮询，避免触发 ntfy 42909
 * "too many auth failures" IP 级封禁）；429 按 Retry-After 退避；其余指数退避。
 */
export class NtfyPollProvider implements CommandProvider {
  readonly name = "ntfy"
  private loop: PollLoop | null = null
  private lastId: string | null = null
  private seeded = false
  private stopped = false

  constructor(
    private readonly serverUrl: string,
    private readonly commandTopic: string,
    private readonly notifyTopic?: string,
    private readonly token?: string,
    private readonly receiptPriority = 2,
    private readonly botTag?: string,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  start(intervalMs: number, onMessage: (m: RawCommandMessage) => void): void {
    if (this.loop) return
    this.stopped = false
    this.loop = new PollLoop(
      intervalMs,
      () => this.tick(onMessage),
      { label: "control[ntfy]" },
    )
    this.loop.start()
  }

  stop(): void {
    this.stopped = true
    this.loop?.stop()
    this.loop = null
  }

  private authHeaders(): Record<string, string> {
    return ntfyAuthHeaders(this.token)
  }

  private async tick(onMessage: (m: RawCommandMessage) => void): Promise<TickOutcome> {
    if (this.stopped) return { kind: "error" }
    const url = ntfyJsonUrl(this.serverUrl, this.commandTopic, this.seeded ? this.lastId : null, true)
    let res: Response
    try {
      res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      // 长轮询超时（无新消息）是正常节拍，不是错误：
      // 走空轮次，让 PollLoop 按基础间隔继续，避免指数退避拖慢命令响应
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /timed? ?out|abort/i.test(e.message))) {
        return { kind: "ok" }
      }
      error(`control[ntfy]: 轮询异常 ${e instanceof Error ? e.message : String(e)}`)
      return { kind: "error" }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        error(`control[ntfy]: 认证失败 HTTP ${res.status}（请检查 token 与话题权限）`)
        return { kind: "auth" }
      }
      if (res.status === 429) {
        // 读取 ntfy 错误体区分 42901(请求频率) / 42909(认证失败封禁)
        let code = ""
        try {
          const body = (await res.json()) as { code?: string | number; error?: string }
          code = body.code !== undefined ? String(body.code) : ""
          if (code === "42909") {
            error(`control[ntfy]: 认证失败过多被封禁(42909)，停止轮询避免加重封禁（请检查 token、话题权限与 ntfy 服务端 ban 配置）`)
            return { kind: "auth" }
          }
        } catch {
          // 响应体非 JSON，回落普通限流处理
        }
        const log = code ? `被限流(${code})` : "被限流"
        debug(`control[ntfy]: ${log}，按 Retry-After 退避`)
        return { kind: "rate-limited", retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")) }
      }
      error(`control[ntfy]: 读取命令失败 HTTP ${res.status}`)
      return { kind: "error" }
    }

    const text = await res.text()
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)

    for (const line of lines) {
      let msg: NtfyMessage
      try {
        msg = JSON.parse(line) as NtfyMessage
      } catch {
        continue
      }
      if (!msg.id) continue
      const isMessage = msg.event === "message"
      this.lastId = msg.id
      if (!this.seeded) continue // 首次：只推进游标
      if (!isMessage) continue
      // 合并单话题：忽略插件自身消息（游标已推进，不影响增量）
      // 双重过滤：tag 标记（正常）+ 回执标题兜底（tag 缺失/配置错误时仍防自激）
      if (isSelfMessage(msg, this.botTag)) continue
      onMessage({
        id: msg.id,
        title: msg.title,
        message: msg.message ?? "",
        time: msg.time ? msg.time * 1000 : undefined,
        tags: msg.tags,
      })
    }

    if (!this.seeded) {
      this.seeded = true
      debug(`control[ntfy]: 初始化游标 lastId=${this.lastId ?? "(空)"}`)
    }

    return { kind: "ok" }
  }

  async publishReceipt(text: string): Promise<void> {
    return publishNtfyReceipt(
      { serverUrl: this.serverUrl, notifyTopic: this.notifyTopic, token: this.token, receiptPriority: this.receiptPriority, botTag: this.botTag },
      text,
    )
  }
}