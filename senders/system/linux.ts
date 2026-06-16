/**
 * Linux 系统通知
 *
 * 使用 notify-send（来自 libnotify）。
 * 支持点击通知打开 Terminator 终端（通过 --action default）。
 * 桌面发行版通常预装，如缺失可:
 *   apt install libnotify-bin / yum install libnotify
 */

import { spawn, execSync } from "node:child_process"

export async function notify(title: string, body: string): Promise<void> {
  // 异步 spawn + --action 实现点击交互
  // --action 隐含 --wait，子进程驻留直到用户交互或通知超时
  // 用户点击通知体 → 收到 "default" action → 聚焦 Terminator
  const proc = spawn("notify-send", [
    "--action", "default=打开",
    "--expire-time", "10000",
    title, body,
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  })

  // 收集用户交互结果
  let output = ""
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  // 用户点击通知 → 聚焦 Terminator
  proc.on("close", () => {
    if (output.trim() === "default") {
      try {
        const wid = execSync(
          "xdotool search --onlyvisible --class Terminator 2>/dev/null | head -1",
          { encoding: "utf-8", timeout: 3000 },
        ).trim()
        if (wid) {
          execSync(`xdotool windowactivate ${wid} 2>/dev/null`, { timeout: 3000 })
        }
      } catch {
        // xdotool 不可用或没有 Terminator 窗口，静默忽略
      }
    }
  })

  // 分离子进程，不阻塞主流程
  proc.unref()
}
