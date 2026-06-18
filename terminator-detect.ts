/**
 * Terminator 子屏幕遮挡检测
 *
 * 检测当前子屏幕是否被真正遮挡（不可见），用于判定是否需要
 * 强制通知（即使用户在该会话中活跃）。
 *
 * 检测策略（两级）：
 *   1. X 窗口级别：Terminator 是否是当前活跃窗口（xprop -root _NET_ACTIVE_WINDOW）
 *      否 → 用户在别的应用中 → 遮挡
 *   2. 子屏级别：用户当前聚焦的是哪个子屏（DBus get_focused_terminal）
 *     聚焦 != 本屏 → 用户在另一个子屏上 → 遮挡
 *
 * 注意：此版本 Terminator 未暴露 get_maximized_terminal 接口，
 * 无法区分"分屏可见"和"最大化遮挡"。两级结合覆盖核心场景：
 *   - Terminator 不活跃（浏览器/IDE）：强制通知
 *   - 本屏聚焦：不通知
 *   - 另一子屏聚焦（分屏或最大化）：强制通知
 */

import { execSync } from "node:child_process"
import { debug } from "./log.js"

/** 当前进程的 TERMINATOR_UUID */
const MY_UUID = process.env.TERMINATOR_UUID ?? null

/** Terminator DBus 信息 */
const DBUS_NAME = process.env.TERMINATOR_DBUS_NAME ?? null
const DBUS_PATH = process.env.TERMINATOR_DBUS_PATH ?? null

/** 是否已确认在 Terminator 中 */
let insideTerminator: boolean | null = null

/**
 * 检测当前子屏幕是否被遮挡（不可见）
 *
 * @returns true  → 本子屏幕被遮挡（用户看不到，应强制通知）
 *          false → 本子屏幕可见（正常抑制逻辑）
 *          null  → 无法确定（不在 Terminator 中或检测失败）
 */
export function isTerminalOccluded(): boolean | null {
  if (!MY_UUID) {
    if (insideTerminator === null) insideTerminator = false
    return null
  }

  insideTerminator = true

  // ─── 第一级：X 窗口级别 ────────────────────────────────────────────────
  // Terminator 窗口是否是当前 X 活跃窗口？
  const terminatorActive = isTerminatorWindowActive()

  if (terminatorActive === false) {
    // 用户在其他应用中（浏览器、IDE 等），本屏不可见
    debug(`Terminator 窗口非活跃（用户在其他应用中），判定为遮挡`)
    return true
  }

  if (terminatorActive === true) {
    // ─── 第二级：聚焦终端检测 ──────────────────────────────────────────
    // Terminator 窗口活跃，检查用户聚焦的是不是本屏
    const focused = queryFocusedTerminal()

    if (focused !== null) {
      if (focused === MY_UUID) {
        debug(`Terminator 本屏聚焦，判定为可见`)
        return false
      }
      // 用户聚焦在另一个子屏上 → 本屏不可见（无论分屏还是最大化）
      debug(`Terminator 用户聚焦在其他子屏(${shortId(focused)})，判定为遮挡`)
      return true
    }

    // 无法查询焦点状态，保守假设可见
    debug(`Terminator 窗口活跃，无法查询焦点状态，保守假设不遮挡`)
    return false
  }

  // 无法确定 X 窗口状态（xprop 失败），保守假设可见
  debug(`无法检测窗口状态（xprop 失败），保守假设不遮挡`)
  return false
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────

/** 取 UUID 前 8 位用于日志 */
function shortId(uuid: string): string {
  return uuid.replace(/^urn:uuid:/i, "").slice(0, 8)
}

// ─── 第一级：X 窗口检测 ──────────────────────────────────────────────────

/**
 * 检测 Terminator 窗口是否是当前 X 活跃窗口
 * @returns true=Terminator 是活跃窗口, false=不是, null=检测失败
 */
function isTerminatorWindowActive(): boolean | null {
  try {
    const out = execSync(
      `xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}' | xargs -I{} xprop -id {} WM_CLASS 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim()
    return out.includes('"Terminator"')
  } catch (e) {
    debug(`xprop 检测 Terminator 窗口失败: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ─── 第二级：聚焦终端检测 ───────────────────────────────────────────────

/**
 * 通过 DBus 查询当前聚焦的子屏 UUID
 * @returns UUID 字符串，或 null（查询失败）
 */
function queryFocusedTerminal(): string | null {
  if (!DBUS_NAME || !DBUS_PATH) return null

  // 策略 1: busctl（无 stderr 输出，避免未知方法报错）
  try {
    const out = execSync(
      `busctl --user call ${DBUS_NAME} ${DBUS_PATH} ${DBUS_NAME} get_focused_terminal 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    const m = out.match(/s\s+"([^"]+)"/)
    if (m) return m[1]
  } catch {
    // 静默忽略
  }

  // 策略 2: gdbus（备选）
  try {
    const out = execSync(
      `gdbus call --session --dest ${DBUS_NAME} --object-path ${DBUS_PATH} --method ${DBUS_NAME}.get_focused_terminal 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    const m = out.match(/\('([^']+)'/)
    if (m) return m[1]
  } catch {
    // 静默忽略
  }

  return null
}
