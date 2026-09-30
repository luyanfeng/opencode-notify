import type { Command, ParseResult } from "./types.js"
import { ITEM_TOKEN_RE, INDEX_RE, isRef } from "./tokens.js"

/**
 * 手机命令解析器
 *
 * 支持的两种命令写法（可混用）：
 *   1) 动词在正文：  消息体 = "approve oc-1a2b-3c4d5e"
 *   2) 动词在标题：  标题 = "approve"，消息体 = "oc-1a2b-3c4d5e"
 *
 * 显式回复协议（不做类型猜测）：
 *   - **动词开头** → 按动词语义（含 approve/always/deny/answer/select/say/stop/status/help）。
 *     无动词文本不猜：`parseCommand("2")` 报「未知动词: 2」。
 *   - **select 的参数**是本协议的分支点：纯数字 → 选该提问第 n 个选项；其它文字 → 当自由回答。
 *   - **其它无动词文本** → 解析失败（controller 据此回执语法提示，绝不猜成某类动作）。
 *
 * 安全校验（两种放行方式）：
 *   - **一次性令牌**：消息中含合法令牌（`oc-<inst>-<rand>`）→ 视为按钮回调，免 secret；
 *     令牌本身一次性、有 TTL，安全性由令牌保证。
 *   - **secret**：手动文本命令需以 secret 作为正文第一个词，否则整条忽略（fail-closed）。
 *
 * 动词（不区分大小写，前导 "/" 可有可无）：
 *   approve 同意/批准 → 允许一次          deny    拒绝/否
 *   always  始终允许                      answer  回答提问
 *   say     向会话追加指令                        stop    中断任务
 *   status  查看状态                      help    帮助
 */

type Action = Command["action"]

/** 动词 → 动作；needsText 表示需要尾随文本 */
const VERBS: Record<string, { action: Action; needsText: boolean }> = {
  // approve / allow
  approve: { action: "approve", needsText: false },
  a: { action: "approve", needsText: false },
  y: { action: "approve", needsText: false },
  yes: { action: "approve", needsText: false },
  ok: { action: "approve", needsText: false },
  "同意": { action: "approve", needsText: false },
  "批准": { action: "approve", needsText: false },
  "允许": { action: "approve", needsText: false },
  // always
  always: { action: "always", needsText: false },
  "始终": { action: "always", needsText: false },
  // deny
  deny: { action: "deny", needsText: false },
  d: { action: "deny", needsText: false },
  n: { action: "deny", needsText: false },
  no: { action: "deny", needsText: false },
  reject: { action: "deny", needsText: false },
  "拒绝": { action: "deny", needsText: false },
  "否": { action: "deny", needsText: false },
  "驳回": { action: "deny", needsText: false },
  // answer
  answer: { action: "answer", needsText: true },
  reply: { action: "answer", needsText: true },
  "回答": { action: "answer", needsText: true },
  "回复": { action: "answer", needsText: true },
  // say
  say: { action: "say", needsText: true },
  msg: { action: "say", needsText: true },
  send: { action: "say", needsText: true },
  "指令": { action: "say", needsText: true },
  "追加": { action: "say", needsText: true },
  // select：选该提问第 n 个选项（凭证强制协议的标准写法）
  // 只有 select 一个入口，命令越少越不容易记错
  select: { action: "choose", needsText: false },
  // stop
  stop: { action: "stop", needsText: false },
  abort: { action: "stop", needsText: false },
  cancel: { action: "stop", needsText: false },
  "中断": { action: "stop", needsText: false },
  "停止": { action: "stop", needsText: false },
  // status / help
  status: { action: "status", needsText: false },
  "状态": { action: "status", needsText: false },
  help: { action: "help", needsText: false },
  "帮助": { action: "help", needsText: false },
}

function norm(word: string): string {
  return word.replace(/^\//, "").toLowerCase()
}

/** 按钮回调免 secret 的动作集合 */
const BUTTON_ACTIONS = new Set<Action>(["approve", "always", "deny", "answer"])

/** 凭证强制协议下必须携带一次性令牌的动作（仅 help 免凭证，且回执不外泄） */
const TOKEN_REQUIRED = new Set<Action>(["approve", "always", "deny", "answer", "say", "stop", "choose", "status"])

/** 是否为一次性条目令牌 */
export function isItemToken(token: string): boolean {
  return ITEM_TOKEN_RE.test(token)
}

interface ParsedParts {
  verb: { action: Action; needsText: boolean }
  ref: string
  args: string[]
}

/** 按已剥离 secret 的词序列解析动词、ref 与参数 */
function parseParts(tokens: string[], titleVerb?: { action: Action; needsText: boolean }): ParsedParts | { error: string } {
  let verb: { action: Action; needsText: boolean } | undefined
  let args: string[]
  if (titleVerb) {
    verb = titleVerb
    args = tokens
  } else {
    if (!tokens.length) return { error: "空消息" }
    verb = VERBS[norm(tokens[0])]
    if (!verb) return { error: `未知动词: ${tokens[0]}` }
    args = tokens.slice(1)
  }
  let ref = ""
  if (args.length > 0 && isRef(args[0])) {
    ref = args[0]
    args = args.slice(1)
  }
  return { verb, ref, args }
}

function finalize(parts: ParsedParts): ParseResult {
  const { verb, ref, args } = parts
  // select：args[0] 纯数字 → 选该提问第 n 个选项；否则整段参数当**自由回答**处理。
  // 通知里的复制按钮模板就是 `select <令牌> `，用户粘贴后既可能补序号、也可能直接写
  // 想说的话——同一个入口两种语义，比要求改用 answer 更顺手（宽容不降低安全性：令牌照旧必填）。
  if (verb.action === "choose") {
    const first = args[0] ?? ""
    if (/^\d+$/.test(first)) {
      return { ok: true, command: { action: "choose", ref, index: Number(first) } }
    }
    const text = args.join(" ").trim()
    if (text) return { ok: true, command: { action: "answer", ref, text } }
    return { ok: false, reason: "select 需要序号或回答（select <令牌> 2 选选项 / select <令牌> 你的回答）" }
  }
  if (verb.needsText) {
    const text = args.join(" ").trim()
    if (!text) return { ok: false, reason: "缺少文本内容" }
    return { ok: true, command: { action: verb.action, ref, text } as Command }
  }
  return { ok: true, command: { action: verb.action, ref } as Command }
}

/**
 * 解析一条命令消息（凭证强制协议）
 *
 * 安全模型（fail-closed）：**所有命令必须携带一次性令牌 `oc-<inst>-<rand>`**。
 * 令牌是唯一的"发送目标"凭证——多实例/多机共用一个话题时，只有持有该令牌的
 * 实例才会受理；无令牌/令牌无效/令牌异主一律解析失败（controller 静默忽略）。
 *
 * 语法（动词可放标题或正文）：
 *   approve <令牌>            deny <令牌>            always <令牌>
 *   answer <令牌> <文本>       say <令牌> <文本>       stop <令牌>
 *   select <令牌> <数字|文本>  （数字=选第 n 个选项；其它文本=当自由回答）
 *   status <令牌>             help
 *
 * @param message 消息体（命令主载体）
 * @param title   消息标题（可承载动词）
 * @param secret  可选共享密钥（仍支持旧 secret 前缀语法）
 */
export function parseCommand(message: string, title?: string, secret?: string): ParseResult {
  const trimmed = (message ?? "").trim()
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const titleVerb = title ? VERBS[norm(title.trim())] : undefined

  const first = parseParts(tokens, titleVerb)
  if (!("error" in first)) {
    const requiresToken = TOKEN_REQUIRED.has(first.verb.action)
    if (requiresToken && !isItemToken(first.ref)) {
      return { ok: false, reason: `缺少令牌（${first.verb.action} 需要一次性令牌）` }
    }
    if (!secret) return finalize(first)
  }

  // 需要 secret（手动命令）：secret 剥离后按同样规则解析
  if (secret) {
    if (tokens[0] !== secret) return { ok: false, reason: "secret 不匹配" }
    const second = parseParts(tokens.slice(1), titleVerb)
    if ("error" in second) return { ok: false, reason: second.error }
    const requiresToken = TOKEN_REQUIRED.has(second.verb.action)
    if (requiresToken && !isItemToken(second.ref)) {
      return { ok: false, reason: `缺少令牌（${second.verb.action} 需要一次性令牌）` }
    }
    return finalize(second)
  }

  // 无 secret 且首轮解析失败
  return { ok: false, reason: ("error" in first ? first.error : "解析失败") }
}

/** 帮助文本（status/help 命令回执用） */
export const HELP_TEXT = [
  "可用命令（所有命令必须携带通知里的一次性令牌 oc-xxxx）:",
  "  approve / deny / always <令牌>   允许一次 / 拒绝 / 始终允许",
  "  answer <令牌> <文本>             回答提问",
  "  select <令牌> <数字>             选择该提问的第 n 个选项",
  "  select <令牌> <文本>             同一入口回复自由文本",
  "  say <令牌> <文本>                向该会话追加指令（续接令牌可反复用）",
  "  stop <令牌>                      中断该会话",
  "  status <令牌>                    查看待处理列表",
  "通知按钮/复制模板可直接用，无需手打。",
  "无令牌的回复会被忽略（多实例安全）。",
].join("\n")
