import { error, warn } from "../log.js"

/**
 * 单次轮询结果
 * - ok           成功
 * - auth         认证失败（401/403）——累计达上限后永久停止
 * - rate-limited 被限流（429）——按 Retry-After 或指数退避
 * - error        其它错误——指数退避
 */
export interface TickOutcome {
  kind: "ok" | "auth" | "rate-limited" | "error"
  /** 限流时服务端建议的重试等待（毫秒） */
  retryAfterMs?: number
}

export interface PollLoopOptions {
  /** 连续认证失败多少次后停止轮询（默认 3） */
  maxAuthFailures?: number
  /** 普通错误退避上限（默认 60s） */
  maxErrorBackoffMs?: number
  /** 限流退避上限（默认 300s） */
  maxRateLimitBackoffMs?: number
  /** 日志标签 */
  label?: string
}

/**
 * 带退避与熔断的轮询循环
 *
 * 由调用方提供单次 tick 的实现，本类负责调度与错误处理：
 * - 成功 → 恢复基础间隔
 * - 认证失败 → 累计，达上限后**永久停止**并报错，避免触发服务端
 *   "认证失败次数过多" 的 IP 级封禁（如 ntfy 42909）
 * - 限流 → 按 Retry-After（若有）或指数退避，上限较高
 * - 其它错误 → 指数退避
 *
 * 采用 setTimeout 自调度（而非 setInterval），天然避免重入与请求堆积。
 */
export class PollLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private running = false
  private consecutiveErrors = 0
  private consecutiveAuth = 0

  private readonly baseIntervalMs: number
  private readonly maxAuthFailures: number
  private readonly maxErrorBackoffMs: number
  private readonly maxRateLimitBackoffMs: number
  private readonly label: string

  constructor(
    baseIntervalMs: number,
    private readonly tick: () => Promise<TickOutcome>,
    opts: PollLoopOptions = {},
  ) {
    this.baseIntervalMs = Math.max(1000, baseIntervalMs)
    this.maxAuthFailures = opts.maxAuthFailures ?? 3
    this.maxErrorBackoffMs = opts.maxErrorBackoffMs ?? 60_000
    this.maxRateLimitBackoffMs = opts.maxRateLimitBackoffMs ?? 300_000
    this.label = opts.label ?? "poll"
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.run(), Math.max(0, delayMs))
    this.timer.unref()
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return
    this.running = true
    let next = this.baseIntervalMs
    try {
      const outcome = await this.tick()
      switch (outcome.kind) {
        case "ok":
          this.consecutiveErrors = 0
          this.consecutiveAuth = 0
          next = this.baseIntervalMs
          break
        case "auth":
          this.consecutiveAuth++
          if (this.consecutiveAuth >= this.maxAuthFailures) {
            error(`${this.label}: 连续 ${this.consecutiveAuth} 次认证失败，已停止轮询。请检查 token 与话题权限后重启 opencode。`)
            this.stopped = true
            return
          }
          next = this.backoff(this.maxErrorBackoffMs)
          break
        case "rate-limited":
          this.consecutiveErrors++
          next = outcome.retryAfterMs ?? this.backoff(this.maxRateLimitBackoffMs)
          next = Math.min(next, this.maxRateLimitBackoffMs)
          warn(`${this.label}: 被限流，${Math.round(next / 1000)}s 后重试`)
          break
        case "error":
          next = this.backoff(this.maxErrorBackoffMs)
          break
      }
    } catch (e) {
      next = this.backoff(this.maxErrorBackoffMs)
      warn(`${this.label}: 轮询异常 ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.running = false
    }
    this.schedule(next)
  }

  /** 指数退避：base × 2^n，封顶 cap */
  private backoff(capMs: number): number {
    this.consecutiveErrors++
    return Math.min(this.baseIntervalMs * Math.pow(2, this.consecutiveErrors), capMs)
  }
}

/** 解析 Retry-After 头（秒数或 HTTP 日期），返回毫秒；无法解析返回 undefined */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}
