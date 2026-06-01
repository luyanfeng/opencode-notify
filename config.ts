/** 通知渠道配置 */
export interface ChannelConfig {
  enabled: boolean
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
  activity_timeout_ms?: number
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
  /** 写入 ~/.opencode-notify/plugin.log 调试日志，默认 false */
  debug_log?: boolean
}

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import yaml from "js-yaml"

/** 默认配置文件路径 */
export function defaultConfigPath(): string {
  return (
    process.env.OPENCODE_NOTIFY_CONFIG ??
    join(homedir(), ".config", "opencode", "opencode-notify.yaml")
  )
}

/** 默认配置模板内容（仅启用系统通知） */
const DEFAULT_CONFIG_TEMPLATE = `# =============================================================================
# opencode-notify 配置文件
# =============================================================================
# 文件位置: ~/.config/opencode/opencode-notify.yaml
# 
# 配置优先级: 此文件 > plugin options > 环境变量 > 默认值
#
# 首次运行自动生成，仅启用了系统通知渠道。
# 其他渠道（企业微信、飞书、自定义 Webhook）可按需取消注释。
#
# 完整配置参考: https://github.com/luyanfeng/opencode-notify
# =============================================================================

channels:
  # 系统消息通知 — 默认启用，开箱即用
  system_message:
    enabled: true

  # 屏幕跑马灯 — Linux X11 专用，取消注释启用
  # screen_flash:
  #   enabled: true
  #   duration: 3.0
  #   speed: 4.0
  #   intensity: 0.9

  # 企业微信 — 取消注释并填入 webhook_url 启用
  # wechat_work:
  #   enabled: true
  #   webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"

  # 飞书 — 取消注释并填入 webhook_url 启用
  # feishu:
  #   enabled: true
  #   webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"

  # 自定义 Webhook — 取消注释并配置 url 启用
  # custom_webhook:
  #   enabled: true
  #   url: ""
  #   method: "POST"
  #   headers: {}
  #   template: ""

# 全局订阅事件（渠道不填则继承此列表）
events:
  - permission_required
  - input_required
  - run_failed

# 去重时间窗口（秒），同一事件窗口内不重复发送
dedupe_seconds: 60

# 会话感知抑制 — 活跃会话跳过屏上可见的通知
suppress_when_active: true
activity_timeout_ms: 15000
suppress_events_when_active:
  - permission_required
  - input_required
session_stale_timeout_ms: 600000

# 调试日志（仅排查问题时开启）
debug_log: false
`

/**
 * 确保配置文件存在，不存在则生成默认模板
 *
 * 如果由 OPENCODE_NOTIFY_CONFIG 自定义了路径，不自动生成（用户明确指定了）
 * 仅在默认路径 ~/.config/opencode/opencode-notify.yaml 不存在时生成
 */
export function ensureConfigFile(): void {
  // 用户自定义了路径 → 不自动生成
  if (process.env.OPENCODE_NOTIFY_CONFIG) return

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
  const configPath =
    process.env.OPENCODE_NOTIFY_CONFIG ??
    join(homedir(), ".config", "opencode", "opencode-notify.yaml")

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
const DEFAULT_CONFIG: Required<Pick<PluginConfig, "suppress_when_active" | "activity_timeout_ms" | "suppress_events_when_active" | "session_stale_timeout_ms" | "debug_log">> & PluginConfig = {
  channels: {
    system_message: { enabled: true },
    screen_flash: { enabled: false },
    wechat_work: { enabled: false },
    feishu: { enabled: false },
    custom_webhook: { enabled: false },
  },
  events: [
    "permission_required",
    "input_required",
    "run_completed",
    "run_failed",
  ],
  dedupe_seconds: 60,
  suppress_when_active: true,
  activity_timeout_ms: 15_000,
  suppress_events_when_active: ["permission_required", "input_required"],
  session_stale_timeout_ms: 600_000,
  debug_log: false,
}

/**
 * 合并配置：options → 环境变量 → 默认值
 */
export function resolveConfig(options: PluginConfig): PluginConfig {
  const wechatWebhook =
    options.channels?.wechat_work?.webhook_url ||
    process.env.OPENCODE_NOTIFY_WECHAT_WEBHOOK

  const feishuWebhook =
    options.channels?.feishu?.webhook_url ||
    process.env.OPENCODE_NOTIFY_FEISHU_WEBHOOK

  const customWebhookUrl =
    options.channels?.custom_webhook?.url ||
    process.env.OPENCODE_NOTIFY_CUSTOM_WEBHOOK_URL

  // 全局 events，各渠道继承此值
  const globalEvents = options.events ?? DEFAULT_CONFIG.events

  // 渠道级 events：有则用渠道的，否则继承全局
  function chEvents(ch: ChannelConfig | undefined): string[] | undefined {
    return ch?.events?.length ? ch.events : undefined
  }

  return {
    channels: {
      system_message: {
        enabled:
          options.channels?.system_message?.enabled ??
          DEFAULT_CONFIG.channels!.system_message!.enabled,
        events: chEvents(options.channels?.system_message),
      },
      screen_flash: {
        enabled:
          options.channels?.screen_flash?.enabled ??
          DEFAULT_CONFIG.channels!.screen_flash!.enabled,
        duration: options.channels?.screen_flash?.duration,
        speed: options.channels?.screen_flash?.speed,
        intensity: options.channels?.screen_flash?.intensity,
        events: chEvents(options.channels?.screen_flash),
      },
      wechat_work: {
        enabled:
          options.channels?.wechat_work?.enabled ??
          DEFAULT_CONFIG.channels!.wechat_work!.enabled,
        webhook_url: wechatWebhook || undefined,
        events: chEvents(options.channels?.wechat_work),
      },
      feishu: {
        enabled:
          options.channels?.feishu?.enabled ??
          DEFAULT_CONFIG.channels!.feishu!.enabled,
        webhook_url: feishuWebhook || undefined,
        events: chEvents(options.channels?.feishu),
      },
      custom_webhook: {
        enabled:
          options.channels?.custom_webhook?.enabled ??
          DEFAULT_CONFIG.channels?.custom_webhook?.enabled ??
          false,
        url: customWebhookUrl || undefined,
        method: options.channels?.custom_webhook?.method ?? "POST",
        headers: options.channels?.custom_webhook?.headers,
        template: options.channels?.custom_webhook?.template,
        events: chEvents(options.channels?.custom_webhook),
      },
    },
    events: globalEvents,
    dedupe_seconds: options.dedupe_seconds ?? DEFAULT_CONFIG.dedupe_seconds,
    suppress_when_active: options.suppress_when_active ?? DEFAULT_CONFIG.suppress_when_active,
    activity_timeout_ms: options.activity_timeout_ms ?? DEFAULT_CONFIG.activity_timeout_ms,
    suppress_events_when_active: options.suppress_events_when_active ?? DEFAULT_CONFIG.suppress_events_when_active,
    session_stale_timeout_ms: options.session_stale_timeout_ms ?? DEFAULT_CONFIG.session_stale_timeout_ms,
    debug_log: options.debug_log ?? DEFAULT_CONFIG.debug_log,
  }
}
