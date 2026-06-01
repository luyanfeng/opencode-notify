/**
 * Windows 系统通知
 *
 * 优先使用 BurntToast（需额外安装），失败时回退为 MessageBox。
 * 安装 BurntToast:
 *   Install-Module -Name BurntToast -Force
 *
 * PowerShell script 使用单引号包裹字符串以避免扩展问题。
 */

import { execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  // PowerShell 脚本：优先 BurntToast，失败回退 MessageBox
  const psScript = [
    `try {`,
    `  New-BurntToastNotification -Text '${title}', '${body}' -ErrorAction Stop`,
    `} catch {`,
    `  Add-Type -AssemblyName System.Windows.Forms`,
    `  [System.Windows.Forms.MessageBox]::Show('${body}', '${title}')`,
    `}`,
  ].join("\n")

  execSync(`powershell -NoProfile -Command ${JSON.stringify(psScript)}`, {
    timeout: 10000,
    stdio: "ignore",
  })
}
