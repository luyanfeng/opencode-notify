/**
 * 系统通知发送器
 *
 * 平台适配：
 * - macOS: osascript（内置，无需额外安装）
 * - Linux: notify-send（需 libnotify）
 * - Windows: PowerShell Toast（需 BurntToast 模块）
 */

import { execSync } from "node:child_process"
import type { Message } from "../message.js"
import type { Sender } from "./types.js"

export class SystemSender implements Sender {
  readonly name = "system"

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
    } catch (err) {
      throw new Error(`系统通知失败: ${err}`)
    }
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
