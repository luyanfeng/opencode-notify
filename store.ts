/**
 * 去重状态存储
 *
 * 基于内存 Map + 可选 JSON 文件持久化。
 * 使用 "预留发送" 机制：预占发送时隙，发送成功后才标记为已发送，
 * 发送失败则释放预留，允许后续重试。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { warn, error } from "./log.js"

interface StoreData {
  lastSent: Record<string, number> // key → unix timestamp (seconds)
}

export class FileStore {
  private lastSent: Record<string, number> = {}
  private reservations: Record<string, number> = {}
  private path: string

  constructor(path?: string) {
    this.path =
      path ?? join(homedir(), ".opencode-notify", "state.json")
    this.load()
  }

  /**
   * 检查是否可以发送（去重检查）
   * 返回 true 表示允许发送
   */
  shouldSend(key: string, windowSec: number, now: number = Date.now()): boolean {
    // 检查已发送记录
    const last = this.lastSent[key]
    if (last && now - last < windowSec * 1000) {
      return false
    }
    // 检查是否已有预留
    const reserved = this.reservations[key]
    if (reserved && now - reserved < windowSec * 1000) {
      return false
    }
    return true
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
    this.save()
  }

  /**
   * 清除预留（发送失败时调用，允许重试）
   */
  clearReservation(key: string): void {
    delete this.reservations[key]
  }

  /** 构建去重 key */
  buildKey(agent: string, event: string, sessionID: string): string {
    return `${agent}:${event}:${sessionID}`
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

  private save(): void {
    try {
      const dir = this.path.substring(0, this.path.lastIndexOf("/"))
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data: StoreData = { lastSent: this.lastSent }
      writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8")
    } catch (e) {
      error(`去重状态持久化失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
