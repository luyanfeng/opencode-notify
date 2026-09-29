import type { PendingItem } from "./types.js"
import { genItemToken } from "./tokens.js"

/**
 * 待处理请求注册表
 *
 * 保存"已通知手机、等待回应"的权限/提问条目，用于：
 *   - 在通知里附带一次性令牌，让手机（按钮）能定点应答
 *   - 令牌为**一次性**：consume 后即失效，第二次点按不会重复执行
 *   - 状态查询与过期清理
 *
 * 有 TTL 与容量上限，防止长期运行内存膨胀。
 */
export class PendingRegistry {
  private items: PendingItem[] = []
  private readonly max: number
  private readonly instance: string
  private readonly ttlMs: number

  constructor(max: number, instance: string, ttlMs: number) {
    this.max = Math.max(0, Math.floor(max))
    this.instance = instance
    this.ttlMs = ttlMs > 0 ? ttlMs : 30 * 60 * 1000
  }

  /**
   * 新增待处理条目，返回带令牌的条目（max=0 时不记录，令牌为空）
   *
   * @param formExtra form 专属：答案字段 key 与选项回传值（permission/session 忽略）
   */
  add(
    kind: PendingItem["kind"],
    requestID: string,
    sessionID: string,
    title: string,
    options?: string[],
    formExtra?: Pick<PendingItem, "answerKey" | "optionValues" | "locationDirectory">,
  ): PendingItem {
    this.prune()
    const base: PendingItem = {
      kind,
      requestID,
      sessionID,
      code: "",
      title: title.slice(0, 120),
      options,
      optionValues: formExtra?.optionValues,
      answerKey: formExtra?.answerKey,
      locationDirectory: formExtra?.locationDirectory,
      createdAt: Date.now(),
    }
    if (this.max === 0) return base

    // 幂等：同一 requestID 已存在 → **复用既有令牌**（仅刷新标题/选项）。
    // opencode 会对同一事件连发多次（实测同一秒双发 run_completed）：若每次都
    // 轮换令牌，首条通知里发给用户的令牌会立刻失效——真机已暴露此 bug
    // （手机拿着令牌 A 回复，注册表已被第 2 次事件轮换成令牌 B → 查无此证）。
    const existing = this.items.find((i) => i.requestID === requestID)
    if (existing) {
      existing.title = base.title
      existing.options = base.options
      existing.optionValues = base.optionValues
      existing.answerKey = base.answerKey
      existing.locationDirectory = base.locationDirectory
      existing.createdAt = Date.now() // 重置 TTL（与"重复事件=仍在等待"语义一致）
      return existing
    }

    const used = new Set(this.items.map((i) => i.code))
    let code = genItemToken(this.instance)
    for (let i = 0; i < 20 && used.has(code); i++) code = genItemToken(this.instance)

    const item: PendingItem = { ...base, code }
    this.items.push(item)
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max)
    }
    return item
  }

  /** 按令牌查找（不消费） */
  getByCode(code: string): PendingItem | undefined {
    this.prune()
    return this.items.find((i) => i.code === code)
  }

  /**
   * 一次性消费：找到即移除并返回；已消费/过期/不存在返回 undefined。
   * 这是"防重复处理"的核心——同一令牌只能成功消费一次。
   */
  consume(code: string): PendingItem | undefined {
    const item = this.getByCode(code)
    if (!item) return undefined
    // session 型凭证（续接会话）TTL 内可复用，不移除
    if (item.kind === "session") return item
    return this.consumeOnce(code)
  }

  /** 真正移除条目（session 型在 TTL 到期后由 prune 清理，或显式调用） */
  private consumeOnce(code: string): PendingItem | undefined {
    this.prune()
    const idx = this.items.findIndex((i) => i.code === code)
    if (idx < 0) return undefined
    return this.items.splice(idx, 1)[0]
  }

  /** 列表（最近插入的在前）— 以插入顺序为准，避免同毫秒时间戳排序不稳定 */
  list(): PendingItem[] {
    this.prune()
    return [...this.items].reverse()
  }

  /** 移除指定 requestID */
  removeByRequestID(requestID: string): void {
    this.items = this.items.filter((i) => i.requestID !== requestID)
  }

  /** 按令牌移除 */
  removeByCode(code: string): void {
    this.items = this.items.filter((i) => i.code !== code)
  }

  /** 清空 */
  clear(): void {
    this.items = []
  }

  /** 清理过期条目 */
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs
    this.items = this.items.filter((i) => i.createdAt >= cutoff)
  }
}
