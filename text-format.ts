import type { Message } from "./message.js"

/**
 * 通知正文纯文本工具（跨渠道共享）
 *
 * 背景：通知正文里的 `**事件：**`、`**选项：**`、`**令牌：**`、`**回复:**` 等
 * key 行是 **markdown 粗体**，只有渲染 markdown 的渠道（ntfy `markdown: true`、
 * 企业微信 `msgtype: markdown`、飞书卡片 `tag: markdown`）才显示成加粗；
 * 纯文本渠道（system 原生通知 / gotify / 自定义 webhook）会把 `**` 原样打出来。
 * 另外各渠道正文长度上限不同（ntfy 4095、企业微信 4096），超限会被平台直接拒绝或静默截断。
 *
 * 本文件放三个正交的小工具（无 IO、无状态，纯文本变换）：
 * - {@link stripInlineBold}：纯文本渠道去掉粗体标记
 * - {@link clampBodyBytes}：发送前按 UTF-8 字节钳制长度，且**永不截断尾部令牌行**
 * - {@link bodyWithReplyHint}：把 msg.replyHint 追加到正文末尾（与 ntfy 既有做法一致）
 * 以及两者共用的上限常量 {@link NOTIFY_BODY_MAX_BYTES}（由两个 dispatch 路径引用，
 * 避免同一个 3600 在两处各写一遍后各自漂移）。
 */

/** 通知正文最大字节数（ntfy 4095 / 企业微信 4096 留余量） */
export const NOTIFY_BODY_MAX_BYTES = 3600

/** 尾部必须完整保留的令牌行前缀（丢了令牌这条通知就彻底无法回复，等于白发） */
const TOKEN_PREFIX = "**令牌：**"

/** 助手历史输出行前缀：超限时优先丢这一行（补充信息，优先级最低） */
const OUTPUT_PREFIX = "**输出：**"

/** 中间截断时插入的提示行 */
const TRUNCATION_NOTICE = "\n…（正文过长已截断）\n"

/** UTF-8 字节数 */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/**
 * 从头部取前 maxBytes 字节（对齐到完整字符边界，不会切出半个 UTF-8 字符）
 */
function sliceUtf8Head(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  if (maxBytes <= 0) return ""
  let end = maxBytes
  // buf[end] 是第一个被排除的字节：若是续接字节(0b10xxxxxx)，说明它所属的字符
  // 起始于 end 之前 → 整个字符都要排除，往前退到起始字节为止
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/**
 * 从尾部取后 maxBytes 字节（同样对齐到字符边界）
 */
function sliceUtf8Tail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  if (maxBytes <= 0) return ""
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf8")
}

/**
 * 去掉正文里的 markdown 粗体标记（`**` → 空）
 *
 * ⚠️ **只能在不渲染 markdown 的渠道使用**（system 原生通知 / gotify / 自定义 webhook）。
 * 在 ntfy / 企业微信 / 飞书上用它会把排版全部拆掉。
 *
 * 行为刻意保持「只做一件事」：无脑删掉所有成对的 `**`，不判断是否成对、不做转义处理。
 * 正文中我们生成的 `**` 只用于 key 行 / 选项行 / 令牌行 / 回复提示行；用户或模型内容里
 * 偶然出现的 `**` 在纯文本渠道本来也不会渲染，去掉无害。
 */
export function stripInlineBold(text: string): string {
  return text.replace(/\*\*/g, "")
}

/**
 * 追加回复提示到正文末尾（有 replyHint 时，body 与 hint 之间一个换行）
 *
 * 分工：ntfy 渠道在 `senders/ntfy.ts` 自己拼 hint，其余渠道（企业微信 / gotify /
 * 自定义 webhook / 系统通知）在此统一追加 —— 否则用户收到 `**令牌：** oc-xxxx`
 * 却不知道该发什么命令。
 */
export function bodyWithReplyHint(msg: Message): string {
  return msg.replyHint ? `${msg.body}\n${msg.replyHint}` : msg.body
}

/** clampBodyBytes 的结果 */
export interface ClampResult {
  /** 钳制后的正文（保证 <= maxBytes 字节） */
  text: string
  /** 是否发生了截断 */
  truncated: boolean
  /**
   * 极端情况：连尾部（令牌行及其后）本身就超过 maxBytes，被硬截断了。
   * 调用方**必须据此记日志**（项目约定：出问题要暴露，不静默吞掉）。
   */
  tokenTruncated?: boolean
}

/**
 * 把正文按 UTF-8 字节钳制到 maxBytes 以内
 *
 * 为什么按字节而不是字符数：中文 1 字符 = 3 字节，ntfy / 企业微信的上限是**字节**。
 *
 * 不变量：
 * 1. 返回值 `byteLength(text) <= maxBytes` 恒成立
 * 2. **尾部永不截断**：`**令牌：** oc-xxxx` 行（及其后的内容）完整保留 ——
 *    丢了令牌这条通知就彻底无法回复，等于白发
 * 3. 超限时优先丢 `**输出：**` 行（助手历史输出，补充信息），再对头部做保头保尾的中间截断
 */
export function clampBodyBytes(text: string, maxBytes: number): ClampResult {
  if (byteLen(text) <= maxBytes) {
    return { text, truncated: false }
  }

  // 以令牌行为界拆成「头部」与「尾部（令牌行及其后）」
  // 用 indexOf（首个）而非 lastIndexOf：万一用户内容里出现过 `**令牌：**` 字样，
  // 首个位置会让尾部包含更多内容，方向上更安全。
  const tokenIdx = text.indexOf(TOKEN_PREFIX)
  const head = tokenIdx >= 0 ? text.slice(0, tokenIdx) : text
  let tail = tokenIdx >= 0 ? text.slice(tokenIdx) : ""

  // 尾部固定保留；极端情况下（尾部自己就超限）从尾部末尾硬截断 ——
  // 令牌行在尾部**开头**，从末尾砍不会伤到令牌本身
  let tokenTruncated = false
  if (byteLen(tail) > maxBytes) {
    tail = sliceUtf8Head(tail, maxBytes)
    tokenTruncated = tokenIdx >= 0
  }

  const budget = maxBytes - byteLen(tail)

  // 优先丢 `**输出：**` 整行
  let headKept = head
  const outIdx = head.indexOf(OUTPUT_PREFIX)
  if (outIdx >= 0) {
    const lineStart = head.lastIndexOf("\n", outIdx) + 1
    const nl = head.indexOf("\n", outIdx)
    const lineEnd = nl === -1 ? head.length : nl
    const withoutOutput = head.slice(0, lineStart) + head.slice(lineEnd)
    if (byteLen(withoutOutput) <= budget) {
      headKept = withoutOutput
    }
  }

  // 仍超限 → 对头部做保头保尾的中间截断
  if (byteLen(headKept) > budget) {
    headKept = middleTruncate(headKept, budget)
  }

  return {
    text: headKept + tail,
    truncated: true,
    ...(tokenTruncated ? { tokenTruncated: true } : {}),
  }
}

/**
 * 取前 maxBytes 字节，尽量对齐到行边界
 *
 * 对齐只在「最近的换行离切口很近」时才做（末尾 1/4 以内）：
 * 正文里存在超长单行（如「输入」行被模型灌了上万字），此时为了对齐而丢掉整行
 * 会把可用预算白扔掉，不如保留按字节切的结果。
 */
function takeHead(s: string, maxBytes: number): string {
  const slice = sliceUtf8Head(s, maxBytes)
  const cut = slice.lastIndexOf("\n")
  if (cut >= 0 && slice.length - cut <= Math.max(maxBytes / 4, 16)) return slice.slice(0, cut)
  return slice
}

/**
 * 取后 maxBytes 字节，尽量对齐到行边界（同 takeHead 的取舍）
 */
function takeTail(s: string, maxBytes: number): string {
  let slice = sliceUtf8Tail(s, maxBytes)
  // 去掉尾部换行：头部是以「令牌行前的 \n」结束的，那不是内容
  if (slice.endsWith("\n")) slice = slice.slice(0, -1)
  const cut = slice.indexOf("\n")
  if (cut >= 0 && cut <= Math.max(maxBytes / 4, 16)) return slice.slice(cut + 1)
  return slice
}

/**
 * 头部中间截断：前半 + 提示行 + 后半
 */
function middleTruncate(head: string, budget: number): string {
  const noticeBytes = byteLen(TRUNCATION_NOTICE)
  if (budget <= noticeBytes) {
    // 连提示行都放不下 → 只留头部最前面若干字节
    return sliceUtf8Head(head, Math.max(budget, 0))
  }

  const contentBudget = budget - noticeBytes
  const headPart = takeHead(head, Math.floor(contentBudget / 2))
  const tailPart = takeTail(head, contentBudget - byteLen(headPart))

  return headPart + TRUNCATION_NOTICE + tailPart
}
