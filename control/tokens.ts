import { randomBytes } from "node:crypto"

/**
 * 令牌与引用标识
 *
 * 一次性令牌（per-item）：`oc-<inst4>-<rand6>`
 *   - inst4：实例前缀，**每个 opencode 进程随机生成**，用于多进程隔离——
 *     只有生成该令牌的进程会执行；其它进程读到后静默忽略。
 *   - rand6：6 位十六进制随机数，配合注册表实现"一次性消费"。
 *
 * 会话码：`sc-<rand4>`，仅用于通知里展示会话身份（已不作为回复凭证）。
 *
 * 序号引用：`#n`（1 = 最近一条）。
 */

function randHex(n: number): string {
  return randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n)
}

/** 生成本进程的实例标识（4 位十六进制） */
export function newInstanceId(): string {
  return randHex(4)
}

/** 生成一次性条目令牌 */
export function genItemToken(instance: string): string {
  return `oc-${instance}-${randHex(6)}`
}

/** 生成会话码 */
export function genSessionCode(): string {
  return `sc-${randHex(4)}`
}

/** 一次性条目令牌格式 */
export const ITEM_TOKEN_RE = /^oc-([0-9a-f]{4})-([0-9a-f]{6})$/
/** 会话码格式 */
export const SESSION_CODE_RE = /^sc-[0-9a-f]{4}$/
/** 序号引用格式 */
export const INDEX_RE = /^#(\d+)$/

/** 取令牌中的实例前缀；非令牌返回 undefined */
export function tokenInstance(token: string): string | undefined {
  const m = ITEM_TOKEN_RE.exec(token)
  return m ? m[1] : undefined
}

/** 是否为可用的引用（令牌 / 会话码 / 序号） */
export function isRef(token: string): boolean {
  return ITEM_TOKEN_RE.test(token) || SESSION_CODE_RE.test(token) || INDEX_RE.test(token)
}
