/**
 * 远程控制通道 — 类型契约
 *
 * 目标：让手机通过 ntfy / Gotify 向本插件发送命令，从而远程应答
 * opencode 的权限请求、提问，或注入指令、中断任务。
 *
 * 数据流（全部为出站连接，公司电脑不监听公网）：
 *   手机 → 消息服务(ntfy/Gotify) → 插件轮询读取 → 调用 opencode 本地 API
 *   插件 → (可选)回执发布回消息服务 → 手机
 *
 * 配置形态：reply 能力挂在对应的通知渠道下（channels.ntfy.reply /
 * channels.gotify.reply），凭据与通知共用，仅在此处补全"读命令/发回执"所需字段。
 */

/** 命令通道服务端类型 */
export type ControlProviderName = "gotify" | "ntfy"

/**
 * ntfy 命令读取传输方式
 * - "stream"（默认）长连接订阅，实时推送、请求少
 * - "poll"   短轮询（每 poll_interval_ms 一次），作为兼容/兜底
 */
export type NtfyTransport = "stream" | "poll"

/**
 * 原始 reply 配置（YAML 输入，未补全默认值）
 * 挂在 channels.ntfy.reply / channels.gotify.reply 下
 */
export interface ReplyConfigInput {
  /** 是否启用命令通道（默认 false） */
  enabled?: boolean
  /** ntfy：命令话题（手机→插件，按钮也 POST 到这里） */
  command_topic?: string
  /** gotify：读命令用 client token（C 开头） */
  client_token?: string
  /** gotify：命令所在 application 的数字 id */
  app_id?: number
  /** 权限/提问通知是否附带操作按钮（仅 ntfy 生效） */
  buttons?: boolean
  /** 权限按钮是否包含"始终允许"（仅 ntfy 生效） */
  button_always?: boolean
  /** 轮询间隔（毫秒，默认 3000） */
  poll_interval_ms?: number
  /** 一次性令牌有效期（毫秒，默认 30 分钟） */
  token_ttl_ms?: number
  /** 记录最近多少条待处理（0=不生成令牌，默认 30） */
  max_pending?: number
  /** 执行后是否发布回执（默认 true） */
  publish_receipt?: boolean
  /**
   * 回执消息优先级（ntfy 1–5 / gotify 0–10，默认 2）。
   * 回执与通知共用同一话题（channel.topic），用较低优先级以免打扰。
   */
  receipt_priority?: number
  /**
   * 按钮发出的命令消息优先级（仅 ntfy；默认不设置，用 ntfy 服务端默认）。
   * 用于手机端订阅 command_topic 时控制该消息的打扰程度。
   */
  command_priority?: number
  /** 手动文本命令的校验词（正文首词）；按钮回调免 secret */
  secret?: string
  /**
   * ntfy 命令读取传输方式（默认 "stream"）。
   * stream=长连接订阅（实时、请求少）；poll=短轮询（兼容/兜底）。
   */
  transport?: NtfyTransport
  /**
   * 插件自身消息的标记 tag（默认 "opencode"）。
   * 合并单话题时，订阅端据此忽略自己发的通知/回执，避免回环。
   */
  bot_tag?: string
  /** 通知是否附 [复制] 按钮（复制 answer/say 命令模板到剪贴板，默认 true） */
  copy_button?: boolean
}

/**
 * 解析后的 reply 配置（controller 消费）
 * 宿主渠道的 server_url / token 已在此展开
 */
export interface ReplyConfig {
  provider: ControlProviderName
  /** 服务端基址（来自宿主渠道，已去尾斜杠） */
  serverUrl: string
  enabled: boolean
  pollIntervalMs: number
  tokenTtlMs: number
  maxPending: number
  secret?: string
  /** 执行后是否发布回执 */
  receipt: boolean
  /** 回执消息优先级 */
  receiptPriority: number
  buttons: boolean
  buttonAlways: boolean

  // ---- ntfy ----
  /** Bearer token（受保护话题需要） */
  ntfyToken?: string
  /** 命令话题（手机→插件，插件轮询） */
  commandTopic?: string
  /** 通知话题（插件→手机；回执也发到这里） */
  notifyTopic?: string
  /** 按钮命令消息优先级（可选） */
  commandPriority?: number
  /** ntfy 命令读取传输方式（stream=长连接 / poll=短轮询） */
  transport?: NtfyTransport
  /**
   * 是否合并单话题：命令话题省略（未配 `command_topic`）时为 true，
   * 此时 `commandTopic === notifyTopic`，插件订阅自己发布的话题，
   * 靠 `botTag` 过滤自身消息防回环。
   */
  merged: boolean
  /** 插件自身消息标记 tag（订阅端据此忽略自播消息） */
  botTag: string
  /** 通知是否附 [复制] 按钮 */
  copyButton: boolean

  // ---- gotify ----
  /** 应用 token（A 开头），用于发布回执（POST /message） */
  appToken?: string
  /** 客户端 token（C 开头），用于读取命令（GET /application/{id}/message） */
  clientToken?: string
  /** 命令所在的 application id */
  appId?: number
}

/** 待处理的权限/提问条目 */
export interface PendingItem {
  /**
   * 条目类型（即凭证语义）：
   * - permission/form：一次性令牌（动作天然只做一次）
   * - session：续接凭证，TTL 内可反复用于 say/stop（过期作废）
   */
  kind: "permission" | "form" | "session"
  /** 回复用的定位 id：permission → requestID；form → formID；session → `session:<会话>` */
  requestID: string
  /** 所属会话 */
  sessionID: string
  /** 通知里展示、手机回复时引用的一次性令牌，如 oc-1a2b-3c4d5e */
  code: string
  /** 展示用标题（工具名 / 问题摘要），不参与解析 */
  title: string
  /** form 的可选项**显示文本**（approve/deny 对 permission 无此选项） */
  options?: string[]
  /** 与 `options` 同序的**回传值**（form 字段的 option.value，用于提交答案） */
  optionValues?: string[]
  /** form 里承载答案的字段 key（提交答案时作为 answer 的键） */
  answerKey?: string
  /** 创建时间（用于 TTL 与"最近"排序） */
  createdAt: number
}

/**
 * opencode 宿主能力桥（V2）
 *
 * V1 时代靠"从注入 client 提取 fetch/headers 自建 v2 SDK client"来应答；
 * V2 插件 ctx 直接提供 `ctx.permission` / `ctx.session` 域，无需自建 client，
 * 也因此不再受"直跑模式不监听端口、serverUrl 是死地址"的困扰。
 *
 * 本接口是该能力的**窄化视图**：由 index.ts 用 ctx 实现，control/ 层只依赖它，
 * 从而 control/ 不直接耦合 opencode 的类型包。
 */
export interface OpencodeBridge {
  /** 应答权限请求（V2：sessionID 必填，decision 取值 once/always/reject） */
  replyPermission(input: {
    sessionID: string
    requestID: string
    decision: "once" | "always" | "reject"
  }): Promise<void>
  /** 提交表单答案（V2 取代 V1 的 question.reply） */
  replyForm(input: {
    sessionID: string
    formID: string
    answer: Record<string, string | number | boolean | ReadonlyArray<string>>
  }): Promise<void>
  /** 向会话注入一条用户指令（V2 是扁平 `{ sessionID, text }`，不再有 parts 数组） */
  prompt(input: { sessionID: string; text: string }): Promise<void>
  /** 中断会话（V2 由 `abort` 改名为 `interrupt`） */
  interrupt(input: { sessionID: string }): Promise<void>
}

/**
 * 通知里的操作按钮（ntfy Actions）
 * - http 动作：设置 `body`（点按后 POST 回命令话题，插件读取执行）
 * - copy 动作：设置 `value`（点按后写入剪贴板，用户粘贴补写后发送）
 * 二选一；ntfy 每条通知最多 3 个按钮（服务端硬限）。
 */
export interface ControlButton {
  label: string
  /** http 动作的请求体（与 value 二选一） */
  body?: string
  /** copy 动作写入剪贴板的内容（与 body 二选一） */
  value?: string
}

/** 手机发来的命令 */
export type Command =
  | { action: "approve"; ref: string }
  | { action: "always"; ref: string }
  | { action: "deny"; ref: string }
  | { action: "answer"; ref: string; text: string }
  | { action: "say"; ref: string; text: string }
  | { action: "stop"; ref: string }
  | { action: "choose"; ref: string; index: number }
  | { action: "status" }
  | { action: "help" }

/** 通道读取到的一条原始命令消息 */
export interface RawCommandMessage {
  /** 服务端消息唯一 id（字符串化，用于去重与游标） */
  id: string
  /** Gotify 的数值 id（ntfy 为 undefined） */
  numericId?: number
  title?: string
  /** 命令正文 */
  message: string
  /** 毫秒时间戳（可选） */
  time?: number
  /** ntfy 消息 tags（用于识别并忽略插件自身消息） */
  tags?: string[]
}

/** 命令通道提供者接口（Gotify / ntfy 各自实现） */
export interface CommandProvider {
  readonly name: string
  /** 启动轮询；provider 内部维护游标，只回调"每条新消息" */
  start(intervalMs: number, onMessage: (m: RawCommandMessage) => void): void
  /** 停止轮询，清理定时器（幂等） */
  stop(): void
  /** 发布回执（未配置回执通道时可为空实现） */
  publishReceipt?(text: string): Promise<void>
}

/** 解析结果：成功 / 忽略（非命令或密钥不符） */
export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; reason: string }
