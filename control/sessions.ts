import { genSessionCode } from "./tokens.js"

/**
 * 会话展示码注册表
 *
 * 为每个会话分配一个稳定短码（`sc-xxxx`），**仅用于在通知里展示**——
 * 帮用户区分"是哪个会话的通知"。凭证强制协议下它**不作为回复凭证**：
 * 回复一律使用通知里的一次性令牌（`pending.ts` 管理）。
 */
export class SessionCodes {
  private idToCode = new Map<string, string>()
  private codeToId = new Map<string, string>()

  /** 获取会话码（不存在则分配） */
  codeFor(sessionID: string): string | undefined {
    if (!sessionID || sessionID === "unknown") return undefined
    const existing = this.idToCode.get(sessionID)
    if (existing) return existing
    let code = genSessionCode()
    for (let i = 0; i < 20 && this.codeToId.has(code); i++) code = genSessionCode()
    this.idToCode.set(sessionID, code)
    this.codeToId.set(code, sessionID)
    return code
  }

  /** 由会话码反查会话 ID */
  sessionFor(code: string): string | undefined {
    return this.codeToId.get(code)
  }

  /** 移除会话 */
  remove(sessionID: string): void {
    const code = this.idToCode.get(sessionID)
    if (code) this.codeToId.delete(code)
    this.idToCode.delete(sessionID)
  }
}
