/**
 * Linux 系统通知
 *
 * 使用 notify-send（来自 libnotify）。
 * 桌面发行版通常预装，如缺失可:
 *   apt install libnotify-bin / yum install libnotify
 */

import { spawnSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  // 使用 spawnSync 避免 shell 转义问题，body 中的换行符自然传递给 notify-send
  spawnSync("notify-send", [title, body], {
    timeout: 5000,
    stdio: "ignore",
  })
}
