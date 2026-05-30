/** 通知渠道配置 */
export interface ChannelConfig {
  enabled: boolean
  /**
   * 渠道级事件过滤 — 仅这些事件触发本渠道通知
   * 不填或留空则继承全局 events
   */
  events?: string[]
}

/** 屏幕跑马灯配置 */
export interface ScreenFlashConfig {
  enabled: boolean
  /** 持续秒数，默认 3.0 */
  duration?: number
  /** 移动速度因子，默认 4.0 */
  speed?: number
  /** 不透明度 0.0–1.0，默认 0.9 */
  intensity?: number
}

/** 系统通知配置 */
export interface SystemChannelConfig extends ChannelConfig {
  /**
   * 屏幕跑马灯 — 通知时屏幕四边高亮闪烁
   * - boolean: true 启用（使用默认参数）
   * - object: 自定义参数
   */
  screen_flash?: boolean | ScreenFlashConfig
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
  system?: SystemChannelConfig
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
   * 当用户活跃（正在操作 TUI）时抑制通知
   * 检测的事件：message.updated / permission.replied / question.replied / command.executed / tui.command.execute
   * @default true
   */
  suppress_when_active?: boolean
  /** 用户活跃超时时间（毫秒），超过此时间无操作视为离开 */
  activity_timeout_ms?: number
  /** 写入 ~/.opencode-notify/plugin.log 调试日志，默认 false */
  debug_log?: boolean
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
const DEFAULT_CONFIG: Required<Pick<PluginConfig, "suppress_when_active" | "activity_timeout_ms" | "debug_log">> & PluginConfig = {
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

  // 解析 screen_flash
  const rawFlash = options.channels?.system?.screen_flash
  let screenFlash: ScreenFlashConfig | undefined
  if (rawFlash === true) {
    screenFlash = { enabled: true }
  } else if (typeof rawFlash === "object" && rawFlash !== null) {
    screenFlash = {
      enabled: rawFlash.enabled,
      duration: rawFlash.duration,
      speed: rawFlash.speed,
      intensity: rawFlash.intensity,
    }
  } else if (rawFlash === false || rawFlash === undefined) {
    screenFlash = undefined
  } else {
    screenFlash = undefined
  }

  // 全局 events，各渠道继承此值
  const globalEvents = options.events ?? DEFAULT_CONFIG.events

  // 渠道级 events：有则用渠道的，否则继承全局
  function chEvents(ch: ChannelConfig | undefined): string[] | undefined {
    return ch?.events?.length ? ch.events : undefined
  }

  return {
    channels: {
      system: {
        enabled:
          options.channels?.system?.enabled ??
          DEFAULT_CONFIG.channels!.system!.enabled,
        screen_flash: screenFlash,
        events: chEvents(options.channels?.system),
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
    debug_log: options.debug_log ?? DEFAULT_CONFIG.debug_log,
  }
}
