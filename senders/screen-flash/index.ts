/**
 * 屏幕跑马灯发送器
 *
 * 通知时在屏幕四边产生彩色跑马灯效果。
 * 当前仅 Linux X11 支持（Python + GTK 透明覆盖窗口）。
 * 其他平台静默忽略。
 */

import type { Sender } from "../types.js"
import type { Message } from "../../message.js"
import type { ScreenFlashChannelConfig } from "../../config.js"
import { flash } from "./linux.js"

export class ScreenFlashSender implements Sender {
  readonly name = "screen_flash"
  private config: ScreenFlashChannelConfig

  constructor(config: ScreenFlashChannelConfig) {
    this.config = config
  }

  async send(_msg: Message): Promise<void> {
    // 仅 Linux 支持跑马灯效果
    if (process.platform !== "linux") return
    await flash(this.config)
  }
}
