/**
 * 系统通知发送器
 *
 * 根据运行平台自动选择实现：
 * - macOS  → darwin.ts  (osascript)
 * - Linux  → linux.ts   (notify-send)
 * - Windows → win32.ts  (WinRT Native Toast + NotifyIcon 回退)
 * - 其他平台 → 静默忽略
 *
 * Windows 首次调用时自动注册快捷方式，使 toast 出现在通知中心。
 */

import type { Sender } from "../types.js"
import type { Message } from "../../message.js"
import { notify as darwinNotify } from "./darwin.js"
import { notify as linuxNotify } from "./linux.js"
import { notify as win32Notify } from "./win32.js"

/** 平台通知函数注册表 */
const notifiers: Record<string, (title: string, body: string) => Promise<void>> = {
  darwin: darwinNotify,
  linux: linuxNotify,
  win32: win32Notify,
}

export class SystemSender implements Sender {
  readonly name = "system_message"

  async send(msg: Message): Promise<void> {
    const fn = notifiers[process.platform]
    if (!fn) return // 其他平台静默忽略

    const { title, body } = sanitize(msg.title, msg.body)
    try {
      await fn(title, body)
    } catch (err) {
      throw new Error(`系统通知失败: ${err}`)
    }
  }
}

/**
 * 转义标题和正文中的特殊字符，防止 shell 注入
 *
 * 各平台实际使用的逃逸：
 * - Linux:  notify-send "${title}" — 只需转义 " $ ` \
 * - macOS:  osascript -e JSON 序列化 — 全自动处理
 * - Windows: PowerShell '${title}' — 只需转义单引号（win32.ts 内部处理）
 */
function sanitize(
  title: string,
  body: string,
): { title: string; body: string } {
  return {
    title: escape(title),
    body: escape(body),
  }
}

function escape(s: string): string {
  return s
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
}
