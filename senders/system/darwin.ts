/**
 * macOS 系统通知
 *
 * 使用 osascript 调用原生通知中心。
 * - display notification: 弹窗 + 声音
 * - 系统内置，无需额外安装
 */

import { execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  const script = `display notification "${body}" with title "${title}" sound name "default"`
  execSync(`osascript -e ${JSON.stringify(script)}`, {
    timeout: 5000,
    stdio: "ignore",
  })
}
