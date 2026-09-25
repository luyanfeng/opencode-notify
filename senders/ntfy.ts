import type { Sender } from "./types.js"
import type { Message } from "../message.js"
import type { ControlButton } from "../control/types.js"

/**
 * Markdown 表格 → 等宽对齐文本表格
 *
 * ntfy Android 的通知弹窗与 App 内均不渲染 Markdown 表格（竖线原样显示，难读）。
 * 实测等宽文本表格在手机上显示最佳，故在 ntfy 渠道发送前做转换：
 *   | 文件 | 状态 |          文件       状态
 *   |---|---|       →      index.ts     已修改
 *   | index.ts | ... |
 *
 * 列宽按"显示宽度"计算（中文/全角字符计 2，其余计 1），保证中文列也对齐。
 */

/** 字符显示宽度：CJK/全角计 2，其余计 1 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK 统一表意文字、全角标点、全角字母数字、韩文等
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首/汉字标点/统一表意
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x20000 && code <= 0x3fffd)  // CJK 扩展
  ) return 2
  return 1
}

function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** 按显示宽度右侧补空格 */
function padEnd(s: string, width: number): string {
  const pad = width - displayWidth(s)
  return s + " ".repeat(Math.max(0, pad))
}

/** 去除单元格内的 Markdown 强调标记（**xx** / `xx`），通知纯文本更干净 */
function stripInlineMd(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim()
}

/** 判断一行是否为 Markdown 表格行 */
function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith("|") && t.endsWith("|") && t.length >= 4
}

/** 是否为表格分隔行（|---|---|） */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}[-:|\s]*$/.test(line)
}

/** 解析表格行为单元格数组（处理转义 \|） */
function parseCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return t.split(/(?<!\\)\|/).map((c) => stripInlineMd(c.replace(/\\\|/g, "|")))
}

/** 是否为合法表格单元格内容（防止把含 | 的普通文本误判为表格） */
function cellsPlausible(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((c) => c.length <= 200)
}

/**
 * 将文本中的 Markdown 表格块转换为等宽对齐的文本表格。
 * 非表格行原样保留；连续表格行视为一个表格块（分隔行剔除）。
 */
export function tablesToMonospace(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    // 找表格块起点：当前行是表格行（非分隔行）
    if (isTableRow(lines[i]) && !isSeparatorRow(lines[i])) {
      const block: string[] = []
      while (i < lines.length && isTableRow(lines[i])) {
        block.push(lines[i])
        i++
      }
      const rows = block.filter((l) => !isSeparatorRow(l)).map(parseCells).filter(cellsPlausible)
      if (rows.length >= 2) {
        // 计算每列最大显示宽度
        const colCount = Math.max(...rows.map((r) => r.length))
        const widths: number[] = []
        for (let c = 0; c < colCount; c++) {
          widths[c] = Math.max(...rows.map((r) => displayWidth(r[c] ?? "")))
        }
        // 每列限宽（防超长单元格撑爆通知），超出截断
        const maxColWidth = 28
        for (let c = 0; c < colCount; c++) widths[c] = Math.min(widths[c], maxColWidth)
        for (const cells of rows) {
          const line = cells
            .slice(0, colCount)
            .map((c, idx) => {
              // 超宽截断（按显示宽度）
              let cell = c
              while (displayWidth(cell) > widths[idx]) cell = cell.slice(0, -1)
              return padEnd(cell, widths[idx])
            })
            .join("  ")
          out.push(line.trimEnd())
        }
      } else {
        // 不是合法表格（如单个含 | 的长行），原样
        out.push(...block)
      }
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join("\n")
}

/** 表格块起始行距上下文的判断辅助（供测试） */
export const _internals = { isTableRow, isSeparatorRow, parseCells, displayWidth, padEnd }

/**
 * ntfy 通知发送器（支持操作按钮）
 *
 * 与 custom_webhook 的区别：本发送器能把 Message.controlButtons 渲染成
 * ntfy 的 Actions —— 手机收到通知后**点按按钮即自动发回命令**（http 动作）
 * 或**把命令模板复制到剪贴板**（copy 动作）。
 *
 * 合并单话题时，发布的通知会带 `tags:[botTag]` 标记，插件订阅端据此忽略自身消息防回环。
 *
 * 采用 ntfy 结构化 JSON 发布（topic/title/message/priority/actions/tags 全在 body）：
 * 避免把中文标题/按钮文案放进 HTTP header（Bun fetch 拒绝非 ASCII header 值）。
 */
export class NtfyNotifySender implements Sender {
  readonly name = "ntfy"

  constructor(
    private readonly serverUrl: string,
    private readonly notifyTopic: string,
    private readonly commandTopic: string,
    private readonly token?: string,
    /** 默认优先级（权限通知会额外提升，见 send） */
    private readonly defaultPriority = 3,
    /** 按钮发出的命令消息优先级（可选；不设则用 ntfy 默认） */
    private readonly commandPriority?: number,
    /** 插件自身消息标记 tag（合并单话题时用于防回环） */
    private readonly botTag?: string,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  async send(msg: Message): Promise<void> {
    // ntfy 的 JSON 发布走根路径 "/"（topic 在 body 里）；
    // POST 到 /topic 时 body 会被当纯文本 message，导致 JSON 串原样显示
    const url = `${this.serverUrl}/`
    const priority = msg.event === "permission_required" ? Math.max(5, this.defaultPriority) : this.defaultPriority
    // Markdown 表格 → 等宽对齐文本表格（通知弹窗与 App 内均可读）
    const text = tablesToMonospace(msg.replyHint ? `${msg.body}\n${msg.replyHint}` : msg.body)
    const payload: Record<string, unknown> = {
      topic: this.notifyTopic,
      title: msg.title,
      message: text,
      priority,
      // 让 ntfy App 内查看时渲染代码块/加粗等（表格已在上面转成等宽文本）
      markdown: true,
    }
    if (this.botTag) payload.tags = [this.botTag]
    const actions = this.buildActions(msg.controlButtons)
    if (actions.length > 0) payload.actions = actions

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`ntfy returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
    }
  }

  /**
   * 生成结构化 actions；无按钮返回空数组。
   * - http 动作（有 body）：POST 回命令话题，插件读取执行
   * - copy 动作（有 value）：写入剪贴板，用户粘贴补写后发送
   * ntfy 服务端硬限每条消息最多 3 个 action。
   */
  private buildActions(buttons?: ControlButton[]): unknown[] {
    if (!buttons || buttons.length === 0) return []
    const cmdUrl = `${this.serverUrl}/${encodeURIComponent(this.commandTopic)}`
    const httpHeaders: Record<string, string> = {}
    if (this.token) httpHeaders.Authorization = `Bearer ${this.token}`
    if (this.commandPriority !== undefined) httpHeaders.Priority = String(this.commandPriority)

    return buttons.slice(0, 3).map((b) => {
      if (b.value !== undefined) {
        // copy：不 clear，用户补写正文时仍能看到通知作参照
        return { action: "copy", label: b.label, value: b.value, clear: false }
      }
      return {
        action: "http",
        label: b.label,
        url: cmdUrl,
        method: "POST",
        headers: httpHeaders,
        body: b.body ?? "",
        clear: true,
      }
    })
  }
}