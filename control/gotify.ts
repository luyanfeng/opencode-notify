import type { CommandProvider, RawCommandMessage } from "./types.js"
import { PollLoop, type TickOutcome } from "./poll-loop.js"
import { debug, error } from "../log.js"

interface GotifyMessage {
  id: number
  appid: number
  message: string
  title?: string | null
  date?: string
  priority?: number
}

interface GotifyPage {
  paging?: { limit?: number; size?: number; since?: number; next?: string }
  messages?: GotifyMessage[]
}

/**
 * Gotify 命令通道（自托管）
 *
 * 读取：GET {base}/application/{appId}/message?limit=N，需 client token（C 开头）。
 *   注意 Gotify 的 `since` 语义是"返回 id 小于该值"且按 id 降序 —— 不能用它取增量。
 *   因此这里每次取最新 N 条，再过滤出 id > lastMaxId 的新消息。
 * 回执：POST {base}/message，需 application token（A 开头）。
 *
 * 错误处理：401/403 认证失败按连续次数熔断；429 按 Retry-After 退避；其余指数退避。
 */
export class GotifyProvider implements CommandProvider {
  readonly name = "gotify"
  private loop: PollLoop | null = null
  private lastMaxId = 0
  private seeded = false
  private stopped = false
  private readonly limit = 100

  constructor(
    private readonly serverUrl: string,
    private readonly appId: number,
    private readonly clientToken: string,
    private readonly appToken?: string,
    private readonly receiptPriority = 2,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  start(intervalMs: number, onMessage: (m: RawCommandMessage) => void): void {
    if (this.loop) return
    this.stopped = false
    this.loop = new PollLoop(
      intervalMs,
      () => this.tick(onMessage),
      { label: "control[gotify]" },
    )
    this.loop.start()
  }

  stop(): void {
    this.stopped = true
    this.loop?.stop()
    this.loop = null
  }

  private async tick(onMessage: (m: RawCommandMessage) => void): Promise<TickOutcome> {
    if (this.stopped) return { kind: "error" }
    const url = `${this.serverUrl}/application/${this.appId}/message?limit=${this.limit}`
    let res: Response
    try {
      res = await fetch(url, {
        headers: { "X-Gotify-Key": this.clientToken },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      error(`control[gotify]: 轮询异常 ${e instanceof Error ? e.message : String(e)}`)
      return { kind: "error" }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        error(`control[gotify]: 认证失败 HTTP ${res.status}（请检查 client token 与权限）`)
        return { kind: "auth" }
      }
      if (res.status === 429) {
        return { kind: "rate-limited" }
      }
      error(`control[gotify]: 读取命令失败 HTTP ${res.status}`)
      return { kind: "error" }
    }

    const data = (await res.json()) as GotifyPage
    const msgs = data.messages ?? []

    // 首次轮询：只记录当前最大 id，跳过历史命令
    if (!this.seeded) {
      this.lastMaxId = msgs.reduce((max, m) => Math.max(max, m.id), 0)
      this.seeded = true
      debug(`control[gotify]: 初始化游标 lastMaxId=${this.lastMaxId}`)
      return { kind: "ok" }
    }

    // 新命令：id > lastMaxId，按 id 升序回调
    const fresh = msgs.filter((m) => m.id > this.lastMaxId).sort((a, b) => a.id - b.id)
    for (const m of fresh) {
      this.lastMaxId = Math.max(this.lastMaxId, m.id)
      onMessage({
        id: String(m.id),
        numericId: m.id,
        title: m.title ?? undefined,
        message: m.message ?? "",
        time: m.date ? Date.parse(m.date) : undefined,
      })
    }

    return { kind: "ok" }
  }

  async publishReceipt(text: string): Promise<void> {
    if (!this.appToken) return
    try {
      const res = await fetch(`${this.serverUrl}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gotify-Key": this.appToken,
        },
        body: JSON.stringify({ title: "opencode 回执", message: text, priority: this.receiptPriority }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) error(`control[gotify]: 回执发布失败 HTTP ${res.status}`)
    } catch (e) {
      error(`control[gotify]: 回执发布异常 ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}