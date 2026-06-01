import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

/**
 * 日志等级（按优先级从高到低）
 */
export type LogLevel = "error" | "warn" | "info" | "debug"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

interface LogState {
  level: LogLevel
  file: string
}

const state: LogState = {
  level: "info",
  file: join(homedir(), ".opencode-notify", "plugin.log"),
}

/**
 * 配置日志系统
 *
 * @param level 日志等级（仅输出 >= 此等级的消息）
 * @param file  日志文件路径（可选，不传保持当前值）
 */
export function configureLog(level: LogLevel, file?: string): void {
  state.level = level
  if (file) state.file = file
  ensureDir()
}

/** 获取当前日志文件路径 */
export function getLogFile(): string {
  return state.file
}

/** 获取当前日志等级 */
export function getLogLevel(): LogLevel {
  return state.level
}

function ensureDir(): void {
  try {
    const dir = dirname(state.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    // 创建目录失败不影响主流程
  }
}

function writeLog(level: LogLevel, msg: string): void {
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[state.level]) return
  try {
    ensureDir()
    writeFileSync(
      state.file,
      `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`,
      { flag: "a" },
    )
  } catch {
    // 日志写入失败不影响主流程
  }
}

/** 错误日志 — 系统无法正常运行或功能不可用 */
export function error(msg: string): void {
  writeLog("error", msg)
}

/** 警告日志 — 潜在问题，但不影响核心功能 */
export function warn(msg: string): void {
  writeLog("warn", msg)
}

/** 信息日志 — 正常运行状态变化 */
export function info(msg: string): void {
  writeLog("info", msg)
}

/** 调试日志 — 详细事件流，仅排查问题时开启 */
export function debug(msg: string): void {
  writeLog("debug", msg)
}
