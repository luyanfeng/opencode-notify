/** 通知渠道配置 */
export interface ChannelConfig {
  enabled: boolean
}

/** 系统通知配置 */
export interface SystemChannelConfig extends ChannelConfig {}

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
  system?: SystemChannelConfig
  wechat_work?: WechatWorkChannelConfig
  feishu?: FeishuChannelConfig
  custom_webhook?: CustomWebhookChannelConfig
}

/** 插件配置 */
export interface PluginConfig {
  channels?: ChannelsConfig
  /** 需要通知的事件列表 */
  events?: string[]
  /** 去重时间窗口（秒），默认 60 */
  dedupe_seconds?: number
  /**
   * 当用户活跃（正在操作 TUI）时抑制通知
   * 检测的事件：message.updated / permission.replied / question.replied / command.executed / tui.command.execute
   * @default true
   */
  suppress_when_active?: boolean
  /** 用户活跃超时时间（毫秒），超过此时间无操作视为离开 */
  activity_timeout_ms?: number
}

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import yaml from "js-yaml"

/**
 * 加载 YAML 配置文件
 *
 * 文件路径优先级:
 * 1. OPENCODE_NOTIFY_CONFIG 环境变量
 * 2. ~/.config/opencode/opencode-notify.yaml
 *
 * 文件不存在时返回 null，插件使用默认配置 + plugin options
 */
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
      system: { ...(base.channels?.system ?? {}), ...(overrides.channels?.system ?? {}) } as any,
      wechat_work: { ...(base.channels?.wechat_work ?? {}), ...(overrides.channels?.wechat_work ?? {}) } as any,
      feishu: { ...(base.channels?.feishu ?? {}), ...(overrides.channels?.feishu ?? {}) } as any,
      custom_webhook: { ...(base.channels?.custom_webhook ?? {}), ...(overrides.channels?.custom_webhook ?? {}) } as any,
    },
  }
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<Pick<PluginConfig, "suppress_when_active" | "activity_timeout_ms">> & PluginConfig = {
  channels: {
    system: { enabled: true },
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
  activity_timeout_ms: 30_000,
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

  return {
    channels: {
      system: {
        enabled:
          options.channels?.system?.enabled ??
          DEFAULT_CONFIG.channels!.system!.enabled,
      },
      wechat_work: {
        enabled:
          options.channels?.wechat_work?.enabled ??
          DEFAULT_CONFIG.channels!.wechat_work!.enabled,
        webhook_url: wechatWebhook || undefined,
      },
      feishu: {
        enabled:
          options.channels?.feishu?.enabled ??
          DEFAULT_CONFIG.channels!.feishu!.enabled,
        webhook_url: feishuWebhook || undefined,
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
      },
    },
    events: options.events ?? DEFAULT_CONFIG.events,
    dedupe_seconds: options.dedupe_seconds ?? DEFAULT_CONFIG.dedupe_seconds,
    suppress_when_active: options.suppress_when_active ?? DEFAULT_CONFIG.suppress_when_active,
    activity_timeout_ms: options.activity_timeout_ms ?? DEFAULT_CONFIG.activity_timeout_ms,
  }
}
