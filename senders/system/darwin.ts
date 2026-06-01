/**
 * macOS 系统通知（⚠️ 未实际测试）
 *
 * 使用 osascript 调用原生通知中心。
 * - display notification: 标题 + 副标题 + 正文 + 声音
 * - 系统内置，无需额外安装
 * - 通知自动进入通知中心
 *
 * AppleScript 双引号使用 `""` 转义（与 shell/JScript 的 `\"` 不同）。
 */

import { execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  // sanitize() 将 " 转义为 \"，但 AppleScript 使用 "" 表示双引号。
  // 此处先还原，再应用 AppleScript 转义。
  const asTitle = aq(title)
  const asBody = aq(body)

  // 提取 title 中的 [ses_xxx] 前缀作为副标题
  const sessionMatch = title.match(/^(\[[^\]]+\])/)
  const asSubtitle = aq(sessionMatch?.[1] ?? "")

  const script = `display notification "${asBody}" with title "${asTitle}" subtitle "${asSubtitle}" sound name "default"`
  execSync(`osascript -e ${JSON.stringify(script)}`, {
    timeout: 5000,
    stdio: "ignore",
  })
}

/**
 * 转为 AppleScript 安全字符串
 * - 还原 sanitize() 的 \" 转义
 * - 用 AppleScript 的 "" 方式转义双引号
 */
function aq(s: string): string {
  return s
    .replace(/\\"/g, '"')  // 还原 sanitize 转义
    .replace(/"/g, '""')   // AppleScript 双引号转义
}
