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

const __dirname = dirname(fileURLToPath(import.meta.url))
const MARQUEE_SCRIPT = join(__dirname, "..", "..", "scripts", "marquee.py")

export async function flash(config: ScreenFlashChannelConfig): Promise<void> {
  const args = [
    MARQUEE_SCRIPT,
    String(config.duration ?? 3.0),
    String(config.speed ?? 4.0),
    String(config.intensity ?? 0.9),
  ]
  const child = spawn("python3", args, {
    stdio: "ignore",
    detached: true,
  })
  child.unref()
}
