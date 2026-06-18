/**
 * Windows 系统通知
 *
 * 策略：
 *   1. 通过注册表注册 opencode-notify 通知发送方
 *   2. WinRT Native Toast — 使用 PowerShell UUID AppId（确认可弹窗）
 *   3. NotifyIcon BalloonTip — 非阻塞式最终回退
 *
 * 注册表路径: HKCU\SOFTWARE\Classes\AppUserModelId\opencode-notify
 * 此注册使通知出现在 Windows 操作中心。
 */

import { execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  try {
    const t = title.replace(/'/g, "''")
    const b = body.replace(/'/g, "''")

    const ps = `
# 注册 opencode-notify 到操作中心
New-Item -Path 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\opencode-notify' -Force -ErrorAction Stop | Out-Null
New-ItemProperty -Path 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\opencode-notify' -Name 'DisplayName' -Value 'opencode-notify' -PropertyType String -Force -ErrorAction Stop | Out-Null
New-ItemProperty -Path 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\opencode-notify' -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null

# 策略 1: WinRT Native Toast (PowerShell AppId)
try {
  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > \$null
  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > \$null
  \$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')
  \$t.SelectSingleNode('//text[@id=\"1\"]').InnerText='${t}'
  \$t.SelectSingleNode('//text[@id=\"2\"]').InnerText='${b}'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show(\$t)
} catch {
  # 策略 2: NotifyIcon 回退
  try {
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    \$n=New-Object System.Windows.Forms.NotifyIcon
    \$n.Icon=[System.Drawing.SystemIcons]::Information
    \$n.Visible=\$true
    \$n.ShowBalloonTip(10000,'${t}','${b}',[System.Windows.Forms.TooltipIcon]::None)
    Start-Sleep -Milliseconds 500
    \$n.Dispose()
  } catch {}
}
`.trim()

    execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, {
      timeout: 15000,
      stdio: "ignore",
    })
  } catch {
    // Windows 系统通知失败不影响主流程
  }
}
