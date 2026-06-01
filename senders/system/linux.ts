/**
 * Linux 系统通知
 *
 * 使用 notify-send（来自 libnotify）。
 * 桌面发行版通常预装，如缺失可:
 *   apt install libnotify-bin / yum install libnotify
 */

import { execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  execSync(`notify-send "${title}" "${body}"`, {
    timeout: 5000,
    stdio: "ignore",
  })
}
