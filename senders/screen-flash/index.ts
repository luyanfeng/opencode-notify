/**
 * 屏幕跑马灯发送器
 *
 * 通知时在屏幕产生彩色闪烁效果，吸引注意力。
 * - Linux  → Python + GTK3 透明覆盖窗口（四边跑马灯动画）
 * - Windows → PowerShell + .NET WinForms 全屏彩色闪烁
 * - macOS / 其他 → 静默忽略
 */

import type { Sender } from "../types.js"
import type { Message } from "../../message.js"
import type { ScreenFlashChannelConfig } from "../../config.js"
import { flash as linuxFlash } from "./linux.js"
import { flash as win32Flash } from "./win32.js"

export class ScreenFlashSender implements Sender {
  readonly name = "screen_flash"
  private config: ScreenFlashChannelConfig

  constructor(config: ScreenFlashChannelConfig) {
    this.config = config
  }

  async send(_msg: Message): Promise<void> {
    if (process.platform === "linux") {
      await linuxFlash(this.config)
    } else if (process.platform === "win32") {
      await win32Flash(this.config)
    }
    // macOS 及其他平台静默忽略
  }
}
