/**
 * 渠道模式
 * - "all"         → 即时通知 + 延迟推送都启用
 * - "delay_only"  → 仅用于延迟推送（不弹即时通知）
 * - "none"        → 禁用
 */
export type ChannelMode = "all" | "delay_only" | "none"

/** 通知渠道配置 */
export interface ChannelConfig {
  mode: ChannelMode
  /**
   * 渠道级事件过滤 — 仅这些事件触发本渠道通知
   * 不填或留空则继承全局 events
   */
  events?: string[]
}

/** 系统消息通知配置 */
export interface SystemMessageChannelConfig extends ChannelConfig {}

/** 屏幕跑马灯渠道配置 */
export interface ScreenFlashChannelConfig extends ChannelConfig {
  /** 持续秒数，默认 3.0 */
  duration?: number
  /** 移动速度因子，默认 4.0 */
  speed?: number
  /** 不透明度 0.0–1.0，默认 0.9 */
  intensity?: number
}

/** 企业微信通知配置 */
export interface WechatWorkChannelConfig extends ChannelConfig {
  webhook_url?: string
}

/** 飞书通知配置 */
export interface FeishuChannelConfig extends ChannelConfig {
  webhook_url?: string
}

/** 自定义 Webhook 配置 */
export interface CustomWebhookChannelConfig extends ChannelConfig {
  url?: string
  method?: "POST" | "GET"
  headers?: Record<string, string>
  /** 消息模板，支持占位符 {{title}} {{body}} {{event}} */
  template?: string
}

/** 渠道配置集合 */
export interface ChannelsConfig {
  system_message?: SystemMessageChannelConfig
  screen_flash?: ScreenFlashChannelConfig
  wechat_work?: WechatWorkChannelConfig
  feishu?: FeishuChannelConfig
  custom_webhook?: CustomWebhookChannelConfig
}

/** 日志配置 */
export interface LogConfig {
  /** 日志等级：error | warn | info | debug，默认 info */
  level?: string
  /** 日志文件路径，默认 ~/.opencode-notify/plugin.log */
  file?: string
}

/** 插件配置 */
export interface PluginConfig {
  channels?: ChannelsConfig
  /**
   * 需要通知的事件列表
   * 可选值:
   *   permission_required  - Agent 需要用户授权（执行命令、读写文件等）
   *   input_required       - Agent 等待用户输入
   *   run_completed        - 任务执行完成（技术预留，暂未实现）
   *   run_failed           - 任务执行失败
   *   run_cancelled        - 用户主动中断任务
   */
  events?: string[]
  /** 去重时间窗口（秒），默认 60 */
  dedupe_seconds?: number
  /**
   * 会话感知抑制开关
   * true  → 会话活跃时按 suppress_events_when_active 列表过滤通知
   * false → 不抑制（旧行为，所有事件都通知）
   * @default true
   */
  suppress_when_active?: boolean
  /**
   * 会话操作超时（毫秒）
   * 超过此时间无操作 → 视为不活跃，不再抑制通知
   * @default 15000
   */
  activity_timeout?: number
  /**
   * 活跃时抑制哪些事件
   * 空数组表示不抑制任何事件（仅跟踪会话，不影响通知）
   * @default ["permission_required", "input_required"]
   */
  suppress_events_when_active?: string[]
  /**
   * 超时会话自动淘汰（毫秒）
   * 会话超过此时间无任何活动 → 从追踪 Map 移除（防内存泄漏）
   * @default 600000 (10 分钟)
   */
  session_stale_timeout_ms?: number
  /**
   * 远程延迟推送渠道列表
   *
   * 这些渠道在正常通知发出后，还会额外进行一次延迟推送。
   * 正常通知不受影响（该发就发），延迟推送是额外补偿。
   *
   * 适用场景：用户不在电脑前时，正常通知可能没看到，
   * 延迟推送在用户仍未操作时再次通知。
   *
   * 用户回到 opencode TUI 操作 → 取消该会话所有待发延迟通知。
   *
   * @default [] （不启用延迟推送）
   */
  remote_delay_channels?: string[]
  /**
   * 远程延迟秒数
   * 正常通知发出后等待此秒数，用户仍无操作则再次通知
   * @default 60
   */
  remote_delay_seconds?: number
  /**
   * 远程延迟最多重复次数
   * @default 3
   */
  remote_delay_max_count?: number
  /**
   * 日志配置
   *
   * level: error | warn | info | debug
   *   - error → 仅记录错误
   *   - warn  → 错误 + 警告
   *   - info  → 错误 + 警告 + 常规信息（默认）
   *   - debug → 全部日志（相当于旧版的 debug_log: true）
   *
   * file: 日志文件路径，默认 ~/.opencode-notify/plugin.log
   */
  log?: LogConfig
}

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import yaml from "js-yaml"

/** 默认配置文件路径 */
export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode-notify.yaml")
}

/** 默认配置模板内容（仅启用系统通知） */
const DEFAULT_CONFIG_TEMPLATE = `# =============================================================================
# opencode-notify 配置文件
# =============================================================================
# 文件位置: ~/.config/opencode/opencode-notify.yaml
#
# 配置优先级: YAML 文件 > plugin options (opencode.json tuple) > 默认值
#
# 首次运行自动生成，仅启用了系统通知渠道，开箱即用。
# 其他渠道按需取消注释即可启用。
# =============================================================================


# =============================================================================
# 通知渠道
# =============================================================================
channels:

  # ---------------------------------------------------------------------------
  # 系统消息通知 (macOS / Linux / Windows)
  # ---------------------------------------------------------------------------
  # 弹出 OS 原生通知横幅，开箱即用，无需额外配置。
  #   macOS  - 使用 osascript (display notification)
  #   Linux  - 使用 notify-send (需 libnotify 包，桌面版通常预装)
  #   Windows - 使用 PowerShell New-BurntToastNotification
  #             (需额外安装 BurntToast 模块)
  #
  # mode 可选值:
  #   all         → 启用即时通知（是否延迟推送由下方 remote_delay_channels 独立控制）
  #   delay_only  → 仅用于远程延迟推送，不弹即时通知
  #   none        → 禁用
  #
  # 纯即时通知（不延迟推送）：mode: all 且不要加入 remote_delay_channels 即可。
  # 纯延迟推送（不即时通知）：mode: delay_only 并加入 remote_delay_channels。
  # ---------------------------------------------------------------------------
  system_message:
    mode: all                        # all | delay_only | none

  # ---------------------------------------------------------------------------
  # 屏幕跑马灯 (Linux X11 专用)
  # ---------------------------------------------------------------------------
  # 屏幕四边彩色高亮闪烁，作为系统通知之外的视觉辅助。
  # 使用 Python + PyGObject(GTK 3)，Ubuntu GNOME 桌面内置。
  # 支持独立配置事件过滤和持续时间/速度/不透明度。
  # 取消下方注释启用：
  # ---------------------------------------------------------------------------
  # screen_flash:
  #   mode: all                      # all | delay_only | none
  #   duration: 3.5                  # 持续秒数
  #   speed: 5.0                     # 移动速度因子
  #   intensity: 0.85                # 不透明度 0.0~1.0

  # ---------------------------------------------------------------------------
  # 企业微信 群机器人 Webhook
  # ---------------------------------------------------------------------------
  # 发送 Markdown 消息到企业微信群聊。
  # 使用前提：在企业微信群中添加群机器人，获取 Webhook URL。
  # 文档: https://developer.work.weixin.qq.com/document/path/99110
  # 取消下方注释并填入 webhook_url 启用：
  # ---------------------------------------------------------------------------
  # wechat_work:
  #   mode: all                      # all | delay_only | none
  #   webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"

  # ---------------------------------------------------------------------------
  # 飞书 自定义机器人 / 流程触发器 Webhook
  # ---------------------------------------------------------------------------
  # 发送卡片消息到飞书群聊。
  # 使用前提：在飞书群中添加自定义机器人，获取 Webhook URL。
  # 文档: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
  # 取消下方注释并填入 webhook_url 启用：
  # ---------------------------------------------------------------------------
  # feishu:
  #   mode: all                      # all | delay_only | none
  #   webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"

  # ---------------------------------------------------------------------------
  # 自定义 Webhook (通用 HTTP POST)
  # ---------------------------------------------------------------------------
  # 发送 HTTP 请求到任意 Webhook 服务。
  # 支持模板插值自动填充消息内容。
  # 适用服务: Gotify, Bark, PushDeer, Slack Webhook, Discord Webhook 等
  #
  # Gotify 配置示例:
  #   url: "https://gotify.example.com/message"
  #   method: "POST"
  #   headers:
  #     X-Gotify-Key: "your-app-token"
  #   template: '{"title":"{{title}}","message":"{{body}}","priority":5}'
  #
  # 模板占位符: {{title}} {{body}} {{event}} {{agent}} {{sessionID}}
  # 取消下方注释并配置 url 启用：
  # ---------------------------------------------------------------------------
  # custom_webhook:
  #   mode: all                      # all | delay_only | none
  #   url: ""
  #   method: "POST"                  # 请求方法: "POST" | "GET"
  #   headers: {}                     # 自定义请求头
  #   template: ""                    # 消息模板（JSON 字符串）


# =============================================================================
# 通知事件订阅
# =============================================================================
# 只订阅你关心的事件类型，减少不必要通知。
#
# ⚠️ 全局 events 是主闸门：只有在此列表中的事件才会生成通知消息。
#    渠道级 events（channels.xxx.events）只能从全局列表中进一步收窄，
#    无法新增全局列表之外的事件。例如全局无 run_cancelled 时，
#    即使渠道配了 run_cancelled 也不会收到。
#
# 可选事件（各渠道也可单独配置 events，从全局列表中进一步筛选）:
#   permission_required  - Agent 需要用户授权（如执行命令、读写文件）
#                          触发: permission.asked / question.asked
#   input_required       - Agent 等待用户输入
#                          触发: session.idle / session.status(idle)
#   run_completed        - 任务执行完成（技术预留，暂未实现）
#   run_failed           - 任务执行失败
#                          触发: session.error
#   run_cancelled        - 用户主动中断任务（Ctrl+C 或点击中断按钮）
#                          触发: session.error (MessageAbortedError)
# ---------------------------------------------------------------------------
events:
  - permission_required               # 权限请求通知（推荐开启）
  - input_required                    # 等待输入通知（推荐开启）
  - run_failed                        # 任务失败通知
  - run_cancelled                     # 用户取消通知（推荐开启）


# =============================================================================
# 去重设置
# =============================================================================
# 同一事件在时间窗口内只发送一次，避免重复骚扰。
# 去重 key: agent:event:sessionID
# 例如 60 秒内同一个会话的权限请求不会重复弹通知。
# ---------------------------------------------------------------------------
dedupe_seconds: 60                   # 去重时间窗口（秒），0 或负数=不限制


# =============================================================================
# 会话感知抑制
# =============================================================================
# 当用户在 opencode TUI 中操作（输入消息、回应权限等），
# 部分通知可能冗余（屏上已可见）。插件追踪每个会话的操作时间戳，
# 只对活跃会话按事件类型选择性过滤。
#
# 检测的用户活跃事件:
#   message.updated      - 用户发送了消息
#   permission.replied   - 用户回应了授权
#   question.replied     - 用户回答了问题
#   command.executed     - 用户执行了命令
#   tui.command.execute  - 用户按键操作 TUI
#
# 抑制规则:
#   permission_required / input_required: 活跃时抑制（屏上可见）
#   run_failed / run_completed / run_cancelled: 始终通知（异步结果，人可能走开）
# ---------------------------------------------------------------------------
suppress_when_active: true           # true=开启会话感知抑制, false=不抑制
activity_timeout: 60                 # 会话操作超时（秒）
                                      # 超过此时间该会话无操作 → 视为不活跃
                                      # AI 推理可能耗时较长，建议设为 60~120
suppress_events_when_active:         # 活跃时抑制哪些事件（不填继承默认）
  - permission_required
  - input_required
  # run_failed / run_completed / run_cancelled 不在列表中 → 始终通知
session_stale_timeout_ms: 600000     # 超时会话自动淘汰（毫秒）
                                     # 10 分钟无任何活动的会话从追踪 Map 移除
                                     # 防止长期运行导致内存泄漏


# =============================================================================
# 远程延迟推送
# =============================================================================
# 正常通知发出后，如果用户长时间未操作，针对指定渠道额外再推送一次。
# 用户回到 opencode TUI 操作 → 自动取消所有待发延迟通知。
#
# 只影响此列表中的渠道，不在列表中的渠道为"纯即时通知"。
# 结合 mode 使用：
#   mode: all         + 在此列表中 → 即时 + 延迟
#   mode: all         + 不在列表中 → 纯即时（不延迟推送）
#   mode: delay_only  + 在此列表中 → 纯延迟（不弹即时通知）
#
# 适用场景：用户离开电脑后，系统通知可能一闪而过没看到，
# 延迟推送在用户仍未回来时再次尝试发出。
#
# remote_delay_seconds 和 remote_delay_max_count 仅在
# remote_delay_channels 非空时生效。
# ---------------------------------------------------------------------------
remote_delay_channels: []            # 启用的延迟推送渠道列表
                                     # 可选: system_message, screen_flash,
                                     #       wechat_work, feishu, custom_webhook
                                     # 空 = 不启用延迟推送
# remote_delay_seconds: 60           # 延迟秒数（默认 60）
# remote_delay_max_count: 3          # 最多重复次数（默认 3）


# =============================================================================
# 日志配置
# =============================================================================
# 所有通知失败、警告、运行信息均写入日志文件。
# 日志等级控制输出详细程度，日常使用 info 即可。
# ---------------------------------------------------------------------------
log:
  level: info                        # 日志等级: error | warn | info | debug
                                     #   error - 仅记录错误
                                     #   warn  - 错误 + 警告
                                     #   info  - 错误 + 警告 + 常规信息（推荐）
                                     #   debug - 全部日志（排查问题时使用）
  # file: "~/.opencode-notify/plugin.log"  # 日志文件路径（可选，默认同上）
`

/**
 * 确保配置文件存在，不存在则生成默认模板
 */
export function ensureConfigFile(): void {
  const configPath = join(homedir(), ".config", "opencode", "opencode-notify.yaml")
  if (existsSync(configPath)) return  // 已存在

  try {
    const configDir = dirname(configPath)
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, "utf-8")
    console.error(`[opencode-notify] 已生成默认配置文件: ${configPath}`)
  } catch {
    // 生成失败不影响插件加载（使用内置默认配置）
  }
}

export function loadYamlConfig(): PluginConfig | null {
  const configPath = join(homedir(), ".config", "opencode", "opencode-notify.yaml")

  if (!existsSync(configPath)) return null

  const raw = readFileSync(configPath, "utf-8")
  return yaml.load(raw) as PluginConfig
}

/**
 * 浅层合并配置：overrides 覆盖 base 的对应字段
 * 用于 YAML 配置 + plugin options 的合并
 */
export function mergeConfig(base: PluginConfig, overrides: PluginConfig): PluginConfig {
  return {
    ...base,
    ...overrides,
    channels: {
      ...(base.channels ?? {}),
      ...(overrides.channels ?? {}),
      system_message: { ...(base.channels?.system_message ?? {}), ...(overrides.channels?.system_message ?? {}) } as any,
      screen_flash: { ...(base.channels?.screen_flash ?? {}), ...(overrides.channels?.screen_flash ?? {}) } as any,
      wechat_work: { ...(base.channels?.wechat_work ?? {}), ...(overrides.channels?.wechat_work ?? {}) } as any,
      feishu: { ...(base.channels?.feishu ?? {}), ...(overrides.channels?.feishu ?? {}) } as any,
      custom_webhook: { ...(base.channels?.custom_webhook ?? {}), ...(overrides.channels?.custom_webhook ?? {}) } as any,
    },
  }
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<Pick<PluginConfig, "suppress_when_active" | "activity_timeout" | "suppress_events_when_active" | "session_stale_timeout_ms" | "remote_delay_seconds" | "remote_delay_max_count">> & PluginConfig = {
  channels: {
    system_message: { mode: "all" },
    screen_flash: { mode: "none" },
    wechat_work: { mode: "none" },
    feishu: { mode: "none" },
    custom_webhook: { mode: "none" },
  },
  events: [
    "permission_required",
    "input_required",
    "run_completed",
    "run_failed",
    "run_cancelled",
  ],
  dedupe_seconds: 60,
  suppress_when_active: true,
  activity_timeout: 60,
  suppress_events_when_active: ["permission_required", "input_required"],
  session_stale_timeout_ms: 600_000,
  remote_delay_channels: [],
  remote_delay_seconds: 60,
  remote_delay_max_count: 3,
  log: { level: "info", file: undefined },
}

/**
 * 合并配置：options → 默认值
 */
export function resolveConfig(options: PluginConfig): PluginConfig {
  // 全局 events，各渠道继承此值
  const globalEvents = options.events ?? DEFAULT_CONFIG.events

  // 渠道级 events：有则用渠道的，否则继承全局
  function chEvents(ch: ChannelConfig | undefined): string[] | undefined {
    return ch?.events?.length ? ch.events : undefined
  }

  return {
    channels: {
      system_message: {
        mode:
          options.channels?.system_message?.mode ??
          DEFAULT_CONFIG.channels!.system_message!.mode,
        events: chEvents(options.channels?.system_message),
      },
      screen_flash: {
        mode:
          options.channels?.screen_flash?.mode ??
          DEFAULT_CONFIG.channels!.screen_flash!.mode,
        duration: options.channels?.screen_flash?.duration,
        speed: options.channels?.screen_flash?.speed,
        intensity: options.channels?.screen_flash?.intensity,
        events: chEvents(options.channels?.screen_flash),
      },
      wechat_work: {
        mode:
          options.channels?.wechat_work?.mode ??
          DEFAULT_CONFIG.channels!.wechat_work!.mode,
        webhook_url: options.channels?.wechat_work?.webhook_url || undefined,
        events: chEvents(options.channels?.wechat_work),
      },
      feishu: {
        mode:
          options.channels?.feishu?.mode ??
          DEFAULT_CONFIG.channels!.feishu!.mode,
        webhook_url: options.channels?.feishu?.webhook_url || undefined,
        events: chEvents(options.channels?.feishu),
      },
      custom_webhook: {
        mode:
          options.channels?.custom_webhook?.mode ??
          DEFAULT_CONFIG.channels?.custom_webhook?.mode ??
          "none",
        url: options.channels?.custom_webhook?.url || undefined,
        method: options.channels?.custom_webhook?.method ?? "POST",
        headers: options.channels?.custom_webhook?.headers,
        template: options.channels?.custom_webhook?.template,
        events: chEvents(options.channels?.custom_webhook),
      },
    },
    events: globalEvents,
    dedupe_seconds: options.dedupe_seconds ?? DEFAULT_CONFIG.dedupe_seconds,
    suppress_when_active: options.suppress_when_active ?? DEFAULT_CONFIG.suppress_when_active,
    activity_timeout: options.activity_timeout ?? DEFAULT_CONFIG.activity_timeout,
    suppress_events_when_active: options.suppress_events_when_active ?? DEFAULT_CONFIG.suppress_events_when_active,
    session_stale_timeout_ms: options.session_stale_timeout_ms ?? DEFAULT_CONFIG.session_stale_timeout_ms,
    remote_delay_channels: options.remote_delay_channels ?? DEFAULT_CONFIG.remote_delay_channels,
    remote_delay_seconds: options.remote_delay_seconds ?? DEFAULT_CONFIG.remote_delay_seconds,
    remote_delay_max_count: options.remote_delay_max_count ?? DEFAULT_CONFIG.remote_delay_max_count,
    log: {
      level: options.log?.level ?? DEFAULT_CONFIG.log?.level ?? "info",
      file: options.log?.file,
    },
  }
}
