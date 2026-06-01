/**
 * Terminator 子屏幕最大化检测
 *
 * 当用户在 Terminator 中最大化某个子屏幕时（Ctrl+Shift+X），
 * 其他子屏幕被遮挡。通过 DBus 查询焦点终端 UUID，
 * 与本进程的 TERMINATOR_UUID 比较，判定本屏是否被遮挡。
 *
 * 检测策略（依次尝试）:
 *   1. busctl（systemd 自带，Ubuntu 预装）
 *   2. python3-dbus（备选）
 *   3. gdbus（GLib 备选）
 *   4. xdotool 窗口类检测（回退，仅判断是否在 Terminator 窗口中）
 */

import { execSync } from "node:child_process"
import { warn, debug } from "./log.js"

/** 当前进程的 TERMINATOR_UUID */
const MY_UUID = process.env.TERMINATOR_UUID ?? null

/** Terminator DBus 信息（每实例唯一） */
const DBUS_NAME = process.env.TERMINATOR_DBUS_NAME ?? null
const DBUS_PATH = process.env.TERMINATOR_DBUS_PATH ?? null

/** 是否已确认在 Terminator 中 */
let insideTerminator: boolean | null = null

/**
 * 检测当前子屏幕是否被遮挡（用户在其他子屏幕上操作）
 *
 * @returns true  → 本子屏幕被遮挡，不应抑制通知
 *          false → 本子屏幕可见，正常抑制逻辑
 *          null  → 无法确定（不在 Terminator 中或检测失败）
 */
export function isTerminalOccluded(): boolean | null {
  if (!MY_UUID) {
    if (insideTerminator === null) insideTerminator = false
    return null
  }

  insideTerminator = true

  // 如果没有 DBus 名称/路径信息，直接回退到 xdotool
  if (!DBUS_NAME || !DBUS_PATH) {
    debug(`Terminator DBus 环境变量不全: name=${DBUS_NAME} path=${DBUS_PATH}，回退到 xdotool`)
    return callXdotool()
  }

  // 策略 1: busctl
  try {
    const focused = callBusctl()
    if (focused !== null) {
      const occluded = !uuidEqual(focused, MY_UUID)
      debug(`Terminator 焦点检测(busctl): 本屏=${shortId(MY_UUID)} 焦点=${shortId(focused)} 遮挡=${occluded}`)
      return occluded
    }
  } catch (e) {
    debug(`Terminator busctl 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 策略 2: python3-dbus
  try {
    const focused = callPythonDBus()
    if (focused !== null) {
      const occluded = !uuidEqual(focused, MY_UUID)
      debug(`Terminator 焦点检测(python): 本屏=${shortId(MY_UUID)} 焦点=${shortId(focused)} 遮挡=${occluded}`)
      return occluded
    }
  } catch (e) {
    debug(`Terminator python-dbus 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 策略 3: gdbus
  try {
    const focused = callGDBus()
    if (focused !== null) {
      const occluded = !uuidEqual(focused, MY_UUID)
      debug(`Terminator 焦点检测(gdbus): 本屏=${shortId(MY_UUID)} 焦点=${shortId(focused)} 遮挡=${occluded}`)
      return occluded
    }
  } catch (e) {
    debug(`Terminator gdbus 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 策略 4: xdotool 窗口类检测（回退）
  try {
    const result = callXdotool()
    debug(`Terminator 窗口检测(xdotool): ${result}`)
    return result
  } catch (e) {
    warn(`Terminator 所有检测策略均失败，最后错误: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * 检查是否在 Terminator 环境中（基于环境变量）
 */
export function isInsideTerminator(): boolean {
  if (insideTerminator !== null) return insideTerminator
  insideTerminator = !!process.env.TERMINATOR_UUID
  return insideTerminator
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────

/** 比较两个 UUID（忽略 urn:uuid: 前缀） */
function uuidEqual(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/^urn:uuid:/i, "")
  return strip(a) === strip(b)
}

/** 取 UUID 前 8 位用于日志 */
function shortId(uuid: string): string {
  return uuid.replace(/^urn:uuid:/i, "").slice(0, 8)
}

// ─── 检测策略实现 ───────────────────────────────────────────────────────────

/** 策略 1: busctl（systemd） */
function callBusctl(): string | null {
  const out = execSync(
    `busctl --user call ${DBUS_NAME} ${DBUS_PATH} ${DBUS_NAME} get_focused_terminal`,
    { encoding: "utf-8", timeout: 3000 },
  ).trim()
  // 输出格式: s "uuid-string"
  const m = out.match(/s\s+"([^"]+)"/)
  return m ? m[1] : null
}

/** 策略 2: python3-dbus */
function callPythonDBus(): string | null {
  const out = execSync(
    `python3 -c "
import dbus
bus = dbus.SessionBus()
proxy = bus.get_object('${DBUS_NAME}', '${DBUS_PATH}')
focused = proxy.get_focused_terminal(dbus_interface='${DBUS_NAME}')
print(focused)
"`,
    { encoding: "utf-8", timeout: 5000 },
  ).trim()
  return out || null
}

/** 策略 3: gdbus（GLib） */
function callGDBus(): string | null {
  const out = execSync(
    `gdbus call --session --dest ${DBUS_NAME} --object-path ${DBUS_PATH} --method ${DBUS_NAME}.get_focused_terminal`,
    { encoding: "utf-8", timeout: 3000 },
  ).trim()
  // 输出格式: ('uuid-string',)
  const m = out.match(/\('([^']+)'/)
  return m ? m[1] : null
}

/** 策略 4: xdotool 窗口类检测 */
function callXdotool(): boolean | null {
  const cls = execSync(
    `xdotool getactivewindow getwindowclassname`,
    { encoding: "utf-8", timeout: 3000 },
  ).trim()
  return cls === "Terminator" ? true : null
}
