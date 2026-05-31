/**
 * 系统通知发送器
 *
 * 平台适配：
 * - macOS: osascript（内置，无需额外安装）
 * - Linux: notify-send（需 libnotify）
 * - Windows: PowerShell Toast（需 BurntToast 模块）
 */

import { execSync, spawnSync } from "node:child_process"
import type { Message } from "../message.js"
import type { Sender } from "./types.js"

export class SystemSender implements Sender {
  readonly name = "system_message"

  async send(msg: Message): Promise<void> {
    const platform = process.platform

    try {
      if (platform === "darwin") {
        const { title, body } = sanitizeForShell(msg.title, msg.body)
        this.sendMacOS(title, body)
      } else if (platform === "linux") {
        const { title, body } = sanitizeForShell(msg.title, msg.body)
        this.sendLinux(title, body)
      } else if (platform === "win32") {
        const { title, body } = sanitizeForPowerShell(msg.title, msg.body)
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
    // 使用 PowerShell 发送通知
    // 注意：使用 spawnSync 直接调用 powershell.exe，绕过 cmd.exe，避免 ETIMEDOUT
    const psScript = `
try {
  New-BurntToastNotification -Text '${title}', '${body}' -ErrorAction Stop
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('${body}', '${title}')
}`
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psScript,
    ], {
      timeout: 10000,
      stdio: "ignore",
    })

    if (result.error) {
      // PowerShell 不可用时降级为 msg.exe 兜底
      try {
        execSync(`msg "%USERNAME%" "${title}: ${body}"`, {
          timeout: 5000,
          stdio: "ignore",
        })
      } catch {
        throw result.error // 抛原始错误
      }
    }
  }
}

/**
 * Shell 转义（macOS/Linux）：转义双引号、单引号、反引号、美元符
 */
function sanitizeForShell(
  title: string,
  body: string,
): { title: string; body: string } {
  return {
    title: sanitizeShell(title),
    body: sanitizeShell(body),
  }
}

function sanitizeShell(s: string): string {
  return s
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
}

/**
 * PowerShell 转义（Windows）：
 * - 单引号字符串内，单引号需写为两个单引号 ''
 * - 其他字符在单引号内为字面量，无需转义
 * - 仅需处理单引号和换行
 */
function sanitizeForPowerShell(
  title: string,
  body: string,
): { title: string; body: string } {
  return {
    title: sanitizePS(title),
    body: sanitizePS(body),
  }
}

function sanitizePS(s: string): string {
  return s
    .replace(/'/g, "''")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
}
