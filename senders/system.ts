/**
 * 系统通知发送器
 *
 * 平台适配：
 * - macOS: osascript（内置，无需额外安装）
 * - Linux: notify-send（需 libnotify）
 * - Windows: PowerShell Toast（需 BurntToast 模块）
 *
 * 跑马灯效果：（Linux X11 专用）
 * - 使用 Python + PyGObject 创建屏幕边缘高亮闪烁
 * - 需 python3 + GTK 3 运行时（Ubuntu GNOME 内置）
 */

import { execSync, spawn } from "node:child_process"
import type { Message } from "../message.js"
import type { Sender } from "./types.js"
import type { ScreenFlashConfig } from "../config.js"

export class SystemSender implements Sender {
  readonly name = "system"
  private flashConfig?: ScreenFlashConfig
  private scriptPath?: string

  constructor(flashConfig?: ScreenFlashConfig, scriptPath?: string) {
    this.flashConfig = flashConfig
    this.scriptPath = scriptPath
  }

  async send(msg: Message): Promise<void> {
    const { title, body } = escapeForShell(msg.title, msg.body)
    const platform = process.platform

    try {
      if (platform === "darwin") {
        this.sendMacOS(title, body)
      } else if (platform === "linux") {
        this.sendLinux(title, body)
      } else if (platform === "win32") {
        this.sendWindows(title, body)
      }
      // 其他平台静默忽略

      // 成功发送后触发跑马灯
      if (platform === "linux" && this.flashConfig?.enabled && this.scriptPath) {
        this.flashScreen()
      }
    } catch (err) {
      throw new Error(`系统通知失败: ${err}`)
    }
  }

  /** 触发屏幕跑马灯效果（非阻塞） */
  private flashScreen(): void {
    const cfg = this.flashConfig!
    const args = [
      this.scriptPath!,
      String(cfg.duration ?? 3.0),
      String(cfg.speed ?? 4.0),
      String(cfg.intensity ?? 0.9),
    ]
    const child = spawn("python3", args, {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
  }

  private sendMacOS(title: string, body: string): void {
    // 使用 osascript 显示原生通知
    const script = `display notification "${body}" with title "${title}" sound name "default"`
    execSync(`osascript -e ${JSON.stringify(script)}`, {
      timeout: 5000,
      stdio: "ignore",
    })
  }

  private sendLinux(title: string, body: string): void {
    execSync(`notify-send "${title}" "${body}"`, {
      timeout: 5000,
      stdio: "ignore",
    })
  }

  private sendWindows(title: string, body: string): void {
    // 尝试使用 BurntToast，失败则用简单 MessageBox
    const psScript = `
try {
  New-BurntToastNotification -Text '${title}', '${body}' -ErrorAction Stop
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('${body}', '${title}')
}`
    execSync(`powershell -NoProfile -Command ${JSON.stringify(psScript)}`, {
      timeout: 10000,
      stdio: "ignore",
    })
  }
}

/**
 * 转义标题和正文中的特殊字符，防止 shell 注入
 */
function escapeForShell(
  title: string,
  body: string,
): { title: string; body: string } {
  return {
    title: sanitize(title),
    body: sanitize(body),
  }
}

function sanitize(s: string): string {
  return s
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
}
