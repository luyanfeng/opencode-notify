/**
 * 去重状态存储
 *
 * 基于内存 Map + 可选 JSON 文件持久化。
 * 使用 "预留发送" 机制：预占发送时隙，发送成功后才标记为已发送，
 * 发送失败则释放预留，允许后续重试。
 *
 * ## 跨进程去重（O_EXCL 原子占位）
 *
 * 内存账本与 state.json 都只在本进程内有效：同时跑多个 opencode server 进程时，
 * 各自都读到"未发送"，同一条通知就会发多遍。
 *
 * 这里为每个去重 key 建一个占位文件，用 `open(path, "wx")`（O_CREAT|O_EXCL，
 * 由操作系统保证原子性）抢占发送权：同一窗口内**有且只有一个调用方能创建成功**，
 * 其余拿到 EEXIST 即判定为重复。占位文件的 mtime 就是窗口起点，
 * 超过 windowSec 视为过期锁，可被后来者删除并抢占。发送失败时 clearReservation
 * 删掉占位，允许重试。
 *
 * ⚠️ 占位文件创建失败（目录不可写等）时**不阻断通知**：记 error 后照常发送。
 * 去重是防噪音的优化，通知送达是主功能，宁可重复也不能不响。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, readdirSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { warn, error, debug } from "./log.js"

interface StoreData {
  lastSent: Record<string, number> // key → unix timestamp (毫秒)
}

/** 占位文件保留时长：去重窗口最长也就几分钟，超过 1 天的必是垃圾 */
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000

export class FileStore {
  private lastSent: Record<string, number> = {}
  private reservations: Record<string, number> = {}
  /** 本进程抢到的占位 token（key → token），释放时据此确认归属 */
  private claimTokens: Record<string, string> = {}
  private path: string
  /** 跨进程原子占位目录（与 state.json 同级） */
  private claimsDir: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private savePending = false

  constructor(path?: string) {
    this.path =
      path ?? join(homedir(), ".opencode-notify", "state.json")
    this.claimsDir = join(dirname(this.path), "claims")
    this.load()
    this.pruneClaims()
  }

  /**
   * 预留发送时隙
   * 返回 true 表示预留成功，可以发送
   */
  reserveSend(key: string, windowSec: number, now: number = Date.now()): boolean {
    // 检查已发送记录
    const last = this.lastSent[key]
    if (last && now - last < windowSec * 1000) {
      return false
    }
    // 检查已有预留
    const reserved = this.reservations[key]
    if (reserved && now - reserved < windowSec * 1000) {
      return false
    }
    // 跨进程原子占位：多个 server 进程之间有且只有一个能抢到
    const token = randomBytes(8).toString("hex")
    if (!this.claimCrossProcess(key, windowSec, now, token)) {
      return false
    }
    this.claimTokens[key] = token
    // 创建新预留
    this.reservations[key] = now
    return true
  }

  /**
   * 标记为已发送
   */
  markSent(key: string, now: number = Date.now()): void {
    this.lastSent[key] = now
    delete this.reservations[key]
    // 占位保持到窗口结束即可，不删（删了窗口内就可能被别人重发）
    delete this.claimTokens[key]
    this.scheduleSave()
  }

  /**
   * 清除预留（发送失败时调用，允许重试）
   */
  clearReservation(key: string): void {
    delete this.reservations[key]
    const token = this.claimTokens[key]
    delete this.claimTokens[key]
    // 释放跨进程占位，让其它进程/实例能重试。
    // ⚠️ 只删自己抢到的：窗口过期后占位可能已被别人抢占，
    //    盲删会毁掉新持有者的去重保证。
    if (!token) return
    const file = this.claimPath(key)
    try {
      if (readFileSync(file, "utf-8") === token) unlinkSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        error(`跨进程去重占位释放失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 构建去重 key */
  buildKey(agent: string, event: string, sessionID: string): string {
    return `${agent}:${event}:${sessionID}`
  }

  private claimPath(key: string): string {
    return join(this.claimsDir, `${createHash("sha1").update(key).digest("hex")}.lock`)
  }

  /**
   * 跨进程原子抢占发送权
   *
   * 返回 true = 抢到（应发送）；false = 窗口内已有别人抢到（判重复）。
   */
  private claimCrossProcess(key: string, windowSec: number, now: number, token: string): boolean {
    const file = this.claimPath(key)
    if (!existsSync(this.claimsDir)) {
      mkdirSync(this.claimsDir, { recursive: true })
    }
    if (this.tryCreateClaim(file, token)) return true

    // 已存在占位：窗口内 → 别人抢到了
    try {
      if (now - statSync(file).mtimeMs < windowSec * 1000) return false
    } catch (e) {
      // 抢到后对方恰好发送失败释放了 → 落到下面重抢
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        error(`跨进程去重占位读取失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 过期锁：删掉重抢一次
    try {
      unlinkSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        error(`过期去重占位删除失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (this.tryCreateClaim(file, token)) return true
    // 重抢失败 = 别人抢先，判重复
    return false
  }

  /**
   * 尝试原子创建占位文件
   *
   * 写入 owner token（clearReservation 靠它确认归属，避免误删别人的占位）。
   *
   * 返回 true = 创建成功（抢到）；false = 已被别人抢到（EEXIST）；
   * 其它错误（目录不可写等）记 error 后返回 true —— 去重不可用但不阻断通知。
   */
  private tryCreateClaim(file: string, token: string): boolean {
    try {
      const fd = openSync(file, "wx")
      try {
        writeFileSync(fd, token)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
      error(`跨进程去重占位创建失败，降级为仅进程内去重: ${e instanceof Error ? e.message : String(e)}`)
      return true
    }
  }

  /** 启动时清理过期占位文件 */
  private pruneClaims(): void {
    let files: string[]
    try {
      if (!existsSync(this.claimsDir)) return
      files = readdirSync(this.claimsDir)
    } catch (e) {
      error(`跨进程去重目录扫描失败: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const now = Date.now()
    let removed = 0
    for (const name of files) {
      const file = join(this.claimsDir, name)
      try {
        if (now - statSync(file).mtimeMs <= CLAIM_MAX_AGE_MS) continue
        unlinkSync(file)
        removed++
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          error(`过期去重占位清理失败 ${name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    if (removed > 0) debug(`跨进程去重: 清理过期占位 ${removed} 个`)
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const raw = readFileSync(this.path, "utf-8")
      const data = JSON.parse(raw) as StoreData
      this.lastSent = data.lastSent ?? {}
    } catch (e) {
      warn(`去重状态文件读取失败，使用空状态: ${e instanceof Error ? e.message : String(e)}`)
      this.lastSent = {}
    }
  }

  /** 防抖保存：1 秒内多次调用合并为一次写入 */
  private scheduleSave(): void {
    if (this.savePending) return
    this.savePending = true
    this.saveTimer = setTimeout(() => {
      this.savePending = false
      this.save()
    }, 1_000)
  }

  private save(): void {
    try {
      const dir = dirname(this.path)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data: StoreData = { lastSent: this.lastSent }
      writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8")
    } catch (e) {
      error(`去重状态持久化失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 立即保存（进程退出时调用） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.savePending) {
      this.savePending = false
      this.save()
    }
  }
}
