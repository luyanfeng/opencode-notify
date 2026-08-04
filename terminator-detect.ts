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
 *
 * 性能：检测结果缓存 5 秒 TTL，避免高频事件重复执行 execSync。
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

/** 遮挡检测结果缓存（5 秒 TTL） */
let cachedOccluded: boolean | null = null
let cachedAt = 0
const CACHE_TTL = 5_000

/** 系统空闲时间缓存（3 秒 TTL） */
let cachedIdleMs: number | null = null
let cachedIdleAt = 0
const IDLE_CACHE_TTL = 3_000

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

  // 缓存命中
  const now = Date.now()
  if (cachedOccluded !== null && now - cachedAt < CACHE_TTL) {
    return cachedOccluded
  }

  // ─── 第一级：X 窗口级别 ────────────────────────────────────────────────
  // Terminator 窗口是否是当前 X 活跃窗口？
  const terminatorActive = isTerminatorWindowActive()

  if (terminatorActive === false) {
    debug(`Terminator 窗口非活跃（用户在其他应用中），判定为遮挡`)
    cachedOccluded = true
    cachedAt = now
    return true
  }

  if (terminatorActive === true) {
    // ─── 第二级：聚焦终端检测 ──────────────────────────────────────────
    const focused = queryFocusedTerminal()

    if (focused !== null) {
      if (focused === MY_UUID) {
        debug(`Terminator 本屏聚焦，判定为可见`)
        cachedOccluded = false
        cachedAt = now
        return false
      }
      debug(`Terminator 用户聚焦在其他子屏(${shortId(focused)})，判定为遮挡`)
      cachedOccluded = true
      cachedAt = now
      return true
    }

    debug(`Terminator 窗口活跃，无法查询焦点状态，保守假设不遮挡`)
    cachedOccluded = false
    cachedAt = now
    return false
  }

  debug(`无法检测窗口状态（xprop 失败），保守假设不遮挡`)
  cachedOccluded = false
  cachedAt = now
  return false
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────

/**
 * 获取系统空闲时间（自上次键盘/鼠标输入以来的毫秒数）
 *
 * 查询策略：
 *   1. org.gnome.Mutter.IdleMonitor.GetIdletime（GNOME，最精确）
 *   2. org.freedesktop.ScreenSaver.GetSessionIdleTime（标准 freedesktop 接口）
 *
 * @returns 空闲毫秒数，或 null（所有检测方法均不可用）
 */
export function getSystemIdleMs(): number | null {
  // 缓存命中
  const now = Date.now()
  if (cachedIdleMs !== null && now - cachedIdleAt < IDLE_CACHE_TTL) {
    return cachedIdleMs
  }

  let result: number | null = null

  // 策略 1: GNOME Mutter IdleMonitor（返回毫秒）
  try {
    const out = execSync(
      `busctl --user call org.gnome.Mutter.IdleMonitor /org/gnome/Mutter/IdleMonitor/Core org.gnome.Mutter.IdleMonitor GetIdletime 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    const m = out.match(/t\s+(\d+)/)
    if (m) result = parseInt(m[1], 10)
  } catch {
    // 静默忽略
  }

  if (result === null) {
    // 策略 2: gdbus 备用
    try {
      const out = execSync(
        `gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core --method org.gnome.Mutter.IdleMonitor.GetIdletime 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 },
      ).trim()
      const m = out.match(/uint64\s+(\d+)/)
      if (m) result = parseInt(m[1], 10)
    } catch {
      // 静默忽略
    }
  }

  if (result === null) {
    // 策略 3: freedesktop.org ScreenSaver（返回秒，需转毫秒）
    try {
      const out = execSync(
        `busctl --user call org.freedesktop.ScreenSaver /ScreenSaver org.freedesktop.ScreenSaver.GetSessionIdleTime 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 },
      ).trim()
      const m = out.match(/u\s+(\d+)/)
      if (m) result = parseInt(m[1], 10) * 1000
    } catch {
      // 静默忽略
    }
  }

  cachedIdleMs = result
  cachedIdleAt = now
  return result
}

/** 取 UUID 前 8 位用于日志 */
function shortId(uuid: string): string {
  return uuid.replace(/^urn:uuid:/i, "").slice(0, 8)
}

// ─── 第一级：X 窗口检测 ──────────────────────────────────────────────────

/**
 * 获取当前 X 活跃窗口的 WM_CLASS 字符串
 * @returns WM_CLASS 字符串，或 null（检测失败）
 */
function getActiveWindowClass(): string | null {
  try {
    const out = execSync(
      `xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}' | xargs -I{} xprop -id {} WM_CLASS 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim()
    return out || null
  } catch (e) {
    debug(`xprop 检测活跃窗口失败: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * 检测 Terminator 窗口是否是当前 X 活跃窗口
 * @returns true=Terminator 是活跃窗口, false=不是, null=检测失败
 */
function isTerminatorWindowActive(): boolean | null {
  const wmClass = getActiveWindowClass()
  if (wmClass === null) return null
  return wmClass.includes('"Terminator"')
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

// ─── 激活状态检测（供延迟推送探针使用）────────────────────────────────

/**
 * 判断本进程是否运行在 Terminator 中
 *
 * 通过 TERMINATOR_UUID 环境变量判断（Terminator 在子屏中注入）。
 * @returns true=Terminator, false=其他终端
 */
export function isTerminator(): boolean {
  return !!MY_UUID
}

/**
 * 获取当前"窗口激活状态"标识，用于探针检测激活状态变化
 *
 * 返回一个可比较的标识，探针只需对比"是否与上次相同"：
 * - Terminator 环境：返回 isTerminalOccluded() 的结果
 *   （true=被遮挡/用户在其他窗口或子屏, false=本子屏可见）
 * - 非 Terminator：返回当前活跃窗口的终端类别
 *   （"Terminator"/"gnome-terminal"/"konsole"/"other"/null）
 *
 * @returns 激活状态标识字符串（任意变化即视为"用户激活/切换了窗口"），或 null（无法检测）
 */
export function getWindowActivationState(): string | null {
  if (isTerminator()) {
    const occluded = isTerminalOccluded()
    if (occluded === null) return null
    return occluded ? "occluded" : "visible"
  }

  // 非 Terminator：只看窗口（不查子屏）
  const wmClass = getActiveWindowClass()
  if (wmClass === null) return null
  // 从 WM_CLASS 提取终端类别（如 "gnome-terminal" / "konsole" / 其他）
  const m = wmClass.match(/"([^"]+)"/)
  const cls = m ? m[1].toLowerCase() : wmClass.toLowerCase()
  // 终端类窗口视为"本终端激活"，非终端窗口统一为 "other"
  const terminalLike = /terminal|term|konsole|xfce|alacritty|kitty|wezterm|foot/i.test(cls)
  return terminalLike ? cls : "other"
}
