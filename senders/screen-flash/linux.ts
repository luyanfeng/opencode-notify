/**
 * Linux X11 屏幕跑马灯
 *
 * 在屏幕四边生成彩色高亮闪烁效果（跑马灯）。
 * 使用 Python + PyGObject(GTK 3) 创建透明覆盖窗口。
 * Ubuntu GNOME 桌面内置依赖，无需额外安装。
 */

import { spawn } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { ScreenFlashChannelConfig } from "../../config.js"
import { warn, error } from "../../log.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MARQUEE_SCRIPT = join(__dirname, "..", "..", "scripts", "linux-marquee.py")

/** 已提示过「Wayland 无 XWayland」的状态位：只提醒一次，避免每条通知刷日志 */
let warnedNoXWayland = false

/**
 * 跑马灯是「覆盖在屏幕最上层」的窗口，对显示后端有硬性要求：
 * - **GTK3 的 Wayland 后端不支持 override-redirect / 任意形状的顶层覆盖层**：
 *   窗口能创建成功，但用户屏幕上**完全看不见**（实测 Wayland 会话下屏幕四边彩色
 *   像素 11 → 11，无变化）。
 * - **X11 后端可以**：override-redirect + input shape（点击穿透）。
 *   Wayland 会话下由 XWayland 提供 X11 服务，GNOME 46 / Wayland 实测可见
 *   （屏幕四边彩色像素 11 → 18005）。
 *
 * 因此 Wayland 会话且存在 DISPLAY 时，强制子进程走 X11 后端。
 *
 * @param base 环境变量（默认取 process.env）
 * @param hasWayland 是否处于 Wayland 会话（默认按 WAYLAND_DISPLAY 判断）
 */
export function resolveEnv(
  base: NodeJS.ProcessEnv = process.env,
  hasWayland: boolean = !!base.WAYLAND_DISPLAY,
): NodeJS.ProcessEnv {
  const env = { ...base }
  if (!env.GDK_BACKEND && hasWayland && env.DISPLAY) {
    env.GDK_BACKEND = "x11"
  }
  return env
}

export async function flash(config: ScreenFlashChannelConfig): Promise<void> {
  const env = resolveEnv()
  if (env.WAYLAND_DISPLAY && !env.DISPLAY && !warnedNoXWayland) {
    warnedNoXWayland = true
    warn("跑马灯：Wayland 会话且无 XWayland（DISPLAY 未设置），覆盖层无法显示")
  }
  try {
    const args = [
      MARQUEE_SCRIPT,
      String(config.duration ?? 3.0),
      String(config.speed ?? 4.0),
      String(config.intensity ?? 0.9),
    ]
    // stderr 必须接管：脚本崩了（如显示器探测失败）时能落日志，
    // 否则 stdio:"ignore" 会让故障彻底静默（曾因此排查不到跑马灯失效）。
    const child = spawn("python3", args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env,
    })
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (e) => {
      error(`跑马灯：进程启动失败 ${e.message}`)
    })
    child.on("exit", (code) => {
      if (code !== 0) {
        error(`跑马灯：退出码=${code} ${stderr.trim().split("\n").slice(-3).join(" | ")}`)
      }
    })
  } catch (e) {
    // Linux 跑马灯失败不影响主流程
    warn(`跑马灯：启动异常 ${e instanceof Error ? e.message : String(e)}`)
  }
}
