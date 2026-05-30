/**
 * 屏幕跑马灯发送器（Linux X11 专用）
 *
 * 通知时在屏幕四边生成彩色高亮闪烁效果。
 * 使用 Python + PyGObject(GTK 3) 创建透明覆盖窗口。
 * Ubuntu GNOME 桌面内置依赖，无需额外安装。
 */

import { spawn } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "../message.js"
import type { Sender } from "./types.js"
import type { ScreenFlashChannelConfig } from "../config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MARQUEE_SCRIPT = join(__dirname, "..", "scripts", "marquee.py")

export class ScreenFlashSender implements Sender {
  readonly name = "screen_flash"
  private config: ScreenFlashChannelConfig

  constructor(config: ScreenFlashChannelConfig) {
    this.config = config
  }

  async send(_msg: Message): Promise<void> {
    if (process.platform !== "linux") return

    const args = [
      MARQUEE_SCRIPT,
      String(this.config.duration ?? 3.0),
      String(this.config.speed ?? 4.0),
      String(this.config.intensity ?? 0.9),
    ]
    const child = spawn("python3", args, {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
  }
}
