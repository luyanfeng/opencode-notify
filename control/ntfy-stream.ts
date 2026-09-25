import type { CommandProvider, RawCommandMessage } from "./types.js"
import { debug, error, warn } from "../log.js"
import { ntfyAuthHeaders, ntfyJsonUrl, publishNtfyReceipt, isSelfMessage, type NtfyMessage } from "./ntfy-common.js"

/** 单次流连接的结果（决定重连策略） */
type StreamOutcome =
  | { kind: "closed" } // 服务端正常结束/看门狗判定死连接
  | { kind: "auth" } // 401/403（含 ntfy 42909 封禁）
  | { kind: "rate-limited"; retryAfterMs?: number } // 429 普通限流
  | { kind: "invalid-since" } // 400：游标失效，需重置后重连
  | { kind: "error" } // 网络/协议错误

export interface NtfyStreamProviderOptions {
  /** 无任何流数据（含 keepalive）多久后判定连接已死并重连，默认 120s */
  keepaliveTimeoutMs?: number
  /** 合并单话题时，忽略带此 tag 的自身消息（防回环） */
  botTag?: string
  /** 连续认证失败多少次后停止，默认 3 */
  maxAuthFailures?: number
  /** 错误退避上限，默认 60s */
  maxErrorBackoffMs?: number
  /** 限流退避上限，默认 300s */
  maxRateLimitBackoffMs?: number
}

/**
 * ntfy 命令通道（流式订阅）
 *
 * 读取：`GET {base}/{commandTopic}/json[?since=<cursor>]` 开启**长连接**，服务端以
 *   NDJSON 持续推送（`event: open | message | keepalive`，keepalive 默认 45s）。
 *   仅处理 `event === "message"`；游标只在 message 行推进（open/keepalive 的 id
 *   不在缓存中，若用作 since 会命中 COALESCE 兜底导致整段缓存重放）。
 *
 * 断线补偿：重连时带 `since=<最后收到的 message id>`，服务端按内部单调行号**排他**
 *   重放该 id 之后的消息（秒级粒度无关）。游标失效（被缓存逐出）时服务端返回
 *   HTTP 400，此时重置游标为 null（流式不带 since 只收新消息，不重放历史）后重连。
 *
 * 健壮性：
 *   - 看门狗：超过 keepaliveTimeoutMs 无任何字节 → abort 重连（服务端不设空闲超时）
 *   - 认证失败（401/403，或 429 且 code=42909）连续达上限 → 永久停止，避免 IP 级封禁
 *   - 限流（429）→ 按 Retry-After 或指数退避
 *   - 其它错误 → 指数退避（1s→60s），连接成功收到数据后复位
 *   - message id 去重（有界）防御游标被逐出后的整段重放
 *
 * 回执：POST {base}/（与通知共用话题），附低优先级。
 */
export class NtfyStreamProvider implements CommandProvider {
  readonly name = "ntfy"

  private controller: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private onMessage: ((m: RawCommandMessage) => void) | null = null

  private started = false
  private stopped = false
  private connecting = false
  private watchdogFired = false

  private cursor: string | null = null
  private consecutiveErrors = 0
  private consecutiveAuth = 0

  /** 已投递 message id（有界，防止游标逐出后的重放重复执行） */
  private readonly delivered = new Set<string>()
  private readonly deliveredOrder: string[] = []
  private static readonly DELIVERED_CAP = 256

  private readonly serverUrl: string
  private readonly baseIntervalMs = 1000
  private readonly keepaliveTimeoutMs: number
  private readonly botTag?: string
  private readonly maxAuthFailures: number
  private readonly maxErrorBackoffMs: number
  private readonly maxRateLimitBackoffMs: number

  constructor(
    serverUrl: string,
    private readonly commandTopic: string,
    private readonly notifyTopic?: string,
    private readonly token?: string,
    private readonly receiptPriority = 2,
    opts: NtfyStreamProviderOptions = {},
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
    this.keepaliveTimeoutMs = opts.keepaliveTimeoutMs ?? 120_000
    this.botTag = opts.botTag
    this.maxAuthFailures = opts.maxAuthFailures ?? 3
    this.maxErrorBackoffMs = opts.maxErrorBackoffMs ?? 60_000
    this.maxRateLimitBackoffMs = opts.maxRateLimitBackoffMs ?? 300_000
  }

  /** intervalMs 对流式无用（保留以满足 CommandProvider 契约） */
  start(_intervalMs: number, onMessage: (m: RawCommandMessage) => void): void {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.onMessage = onMessage
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    this.started = false
    this.clearReconnectTimer()
    this.clearWatchdog()
    this.controller?.abort()
    this.controller = null
  }

  async publishReceipt(text: string): Promise<void> {
    return publishNtfyReceipt(
      { serverUrl: this.serverUrl, notifyTopic: this.notifyTopic, token: this.token, receiptPriority: this.receiptPriority, botTag: this.botTag },
      text,
    )
  }

  // ── 调度 ────────────────────────────────────────────────────────────────

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.reconnectTimer = setTimeout(() => void this.run(), Math.max(0, delayMs))
    this.reconnectTimer.unref()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** 运行一轮连接 → 依据结果决定重连延迟，形成自调度循环（无重入） */
  private async run(): Promise<void> {
    if (this.stopped || this.connecting) return
    this.connecting = true
    let outcome: StreamOutcome
    try {
      outcome = await this.connectOnce()
    } catch (e) {
      error(`control[ntfy]: 流异常 ${e instanceof Error ? e.message : String(e)}`)
      outcome = { kind: "error" }
    } finally {
      this.connecting = false
      this.clearWatchdog()
      this.controller = null
    }

    if (this.stopped) return

    let delay = this.baseIntervalMs
    switch (outcome.kind) {
      case "closed":
        delay = this.baseIntervalMs
        break
      case "auth":
        this.consecutiveAuth++
        if (this.consecutiveAuth >= this.maxAuthFailures) {
          error(
            `control[ntfy]: 连续 ${this.consecutiveAuth} 次认证失败，已停止流订阅。` +
              `请检查 token、话题权限与 ntfy 服务端封禁配置后重启 opencode。`,
          )
          this.stopped = true
          return
        }
        delay = this.backoff(this.maxErrorBackoffMs)
        break
      case "rate-limited":
        delay = Math.min(outcome.retryAfterMs ?? this.backoff(this.maxRateLimitBackoffMs), this.maxRateLimitBackoffMs)
        warn(`control[ntfy]: 被限流，${Math.round(delay / 1000)}s 后重连`)
        break
      case "invalid-since":
        // 游标被缓存逐出：重置为 null 重连（不带 since 只收新消息，避免整段重放）
        debug("control[ntfy]: 游标失效，重置后重连")
        this.cursor = null
        delay = this.baseIntervalMs
        break
      case "error":
        delay = this.backoff(this.maxErrorBackoffMs)
        break
    }
    this.schedule(delay)
  }

  /** 单次流连接：建立 → 读流 → 返回结束原因；调用方据此重连 */
  private async connectOnce(): Promise<StreamOutcome> {
    const onMessage = this.onMessage
    if (!onMessage) return { kind: "closed" }

    const url = ntfyJsonUrl(this.serverUrl, this.commandTopic, this.cursor, false)
    const ac = new AbortController()
    this.controller = ac
    this.watchdogFired = false
    this.armWatchdog(ac)

    let res: Response
    try {
      res = await fetch(url, { headers: ntfyAuthHeaders(this.token), signal: ac.signal })
    } catch (e) {
      // stop()/看门狗触发的 abort 不算网络错误
      if (this.stopped) return { kind: "closed" }
      if (this.watchdogFired) return { kind: "closed" }
      error(`control[ntfy]: 连接失败 ${e instanceof Error ? e.message : String(e)}`)
      return { kind: "error" }
    }

    if (!res.ok) {
      return this.handleHttpError(res)
    }

    // 连接建立成功 → 复位退避与认证计数
    this.consecutiveErrors = 0
    this.consecutiveAuth = 0
    debug(`control[ntfy]: 流已连接${this.cursor ? ` since=${this.cursor}` : " (仅新消息)"}`)

    try {
      await this.readStream(res, ac, onMessage)
    } catch (e) {
      if (this.stopped || ac.signal.aborted) {
        return { kind: "closed" }
      }
      error(`control[ntfy]: 读取流异常 ${e instanceof Error ? e.message : String(e)}`)
      return { kind: "error" }
    }
    // 流自然结束（服务端关闭/看门狗 abort）→ 重连
    return { kind: "closed" }
  }

  /** 读取 NDJSON 长连接，逐行解析；任意字节重置看门狗 */
  private async readStream(res: Response, ac: AbortController, onMessage: (m: RawCommandMessage) => void): Promise<void> {
    const body = res.body
    if (!body) throw new Error("响应无 body")

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.touchWatchdog()
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) this.handleLine(line, onMessage)
        }
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
  }

  private handleLine(line: string, onMessage: (m: RawCommandMessage) => void): void {
    let msg: NtfyMessage
    try {
      msg = JSON.parse(line) as NtfyMessage
    } catch {
      return
    }
    // 游标只在真实 message 行推进：open/keepalive 的 id 不在缓存，用作 since 会触发整段重放
    if (msg.event !== "message" || !msg.id) return
    this.cursor = msg.id

    // 合并单话题：忽略插件自身消息（游标已推进，不影响增量补漏）
    // 双重过滤：tag 标记（正常）+ 回执标题兜底（tag 缺失/配置错误时仍防自激）
    if (isSelfMessage(msg, this.botTag)) return

    if (this.delivered.has(msg.id)) return
    this.remember(msg.id)
    onMessage({
      id: msg.id,
      title: msg.title,
      message: msg.message ?? "",
      time: msg.time ? msg.time * 1000 : undefined,
      tags: msg.tags,
    })
  }

  private remember(id: string): void {
    this.delivered.add(id)
    this.deliveredOrder.push(id)
    if (this.deliveredOrder.length > NtfyStreamProvider.DELIVERED_CAP) {
      const old = this.deliveredOrder.shift()
      if (old) this.delivered.delete(old)
    }
  }

  private async handleHttpError(res: Response): Promise<StreamOutcome> {
    if (res.status === 401 || res.status === 403) {
      error(`control[ntfy]: 认证失败 HTTP ${res.status}（请检查 token 与话题权限）`)
      await this.drain(res)
      return { kind: "auth" }
    }
    if (res.status === 429) {
      let code = ""
      try {
        const body = (await res.json()) as { code?: string | number }
        code = body.code !== undefined ? String(body.code) : ""
      } catch {
        // 响应体非 JSON，按普通限流处理
      }
      if (code === "42909") {
        error("control[ntfy]: 认证失败过多被封禁(42909)，停止订阅避免加重封禁（请检查 token、话题权限与 ban 配置）")
        return { kind: "auth" }
      }
      warn(`control[ntfy]: 被限流${code ? `(${code})` : ""}，按 Retry-After 退避`)
      return { kind: "rate-limited", retryAfterMs: parseRetryAfterMs(res.headers.get("Retry-After")) }
    }
    if (res.status === 400) {
      await this.drain(res)
      // 已有游标才可能因失效触发；游标为空仍 400 → 真正的请求/配置错误，走退避不重置
      if (this.cursor) {
        warn("control[ntfy]: 游标失效(HTTP 400)，重置游标后重连")
        return { kind: "invalid-since" }
      }
      error("control[ntfy]: 订阅请求被拒(HTTP 400)，请检查 server_url / command_topic")
      return { kind: "error" }
    }
    error(`control[ntfy]: 订阅失败 HTTP ${res.status}`)
    await this.drain(res)
    return { kind: "error" }
  }

  /** 丢弃错误响应体，释放连接 */
  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel()
    } catch {
      // 忽略
    }
  }

  // ── 看门狗 ──────────────────────────────────────────────────────────────

  private armWatchdog(ac: AbortController): void {
    this.watchdogTimer = setTimeout(() => {
      this.watchdogFired = true
      warn(`control[ntfy]: 超过 ${Math.round(this.keepaliveTimeoutMs / 1000)}s 未收到流数据，判定连接已死，重连`)
      ac.abort()
    }, this.keepaliveTimeoutMs)
    this.watchdogTimer.unref()
  }

  private touchWatchdog(): void {
    if (!this.watchdogTimer) return
    // 仅重置到期时间：清掉旧定时器后由 armWatchdog 重设需要 ac，这里直接重排同一回调
    const ac = this.controller
    if (!ac) return
    this.clearWatchdog()
    this.armWatchdog(ac)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /** 指数退避：base × 2^n，封顶 cap */
  private backoff(capMs: number): number {
    this.consecutiveErrors++
    return Math.min(this.baseIntervalMs * Math.pow(2, this.consecutiveErrors), capMs)
  }
}

/** 解析 Retry-After 头（秒数或 HTTP 日期），返回毫秒；无法解析返回 undefined */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}
