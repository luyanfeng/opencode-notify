import type { Plugin } from "@opencode-ai/plugin"
import type { PluginConfig } from "./config.js"
import { resolveConfig, loadYamlConfig, mergeConfig, ensureConfigFile } from "./config.js"
import { route } from "./events.js"
import { Dispatcher } from "./dispatcher.js"
import { FileStore } from "./store.js"
import { SystemSender } from "./senders/system/index.js"
import { ScreenFlashSender } from "./senders/screen-flash/index.js"
import { CustomWebhookSender } from "./senders/custom-webhook.js"
import { WechatWorkSender } from "./senders/wechat-work.js"
import { FeishuSender } from "./senders/feishu.js"
import { FilteredSender } from "./senders/types.js"
import { SessionTracker } from "./session-tracker.js"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MARQUEE_SCRIPT = join(__dirname, "scripts", "marquee.py")

const LOG_DIR = join(homedir(), ".opencode-notify")
const LOG_FILE = join(LOG_DIR, "plugin.log")

let debugEnabled = false

function enableDebug() {
  debugEnabled = true
}

function log(msg: string) {
  if (!debugEnabled) return
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" })
  } catch {
    // 日志写入失败不影响主流程
  }
}

// 用户活跃事件类型（这些事件表明用户正在操作 opencode 的某个会话）
const USER_ACTIVITY_EVENTS = new Set([
  "message.updated",
  "permission.replied",
  "question.replied",
  "command.executed",
  "tui.command.execute",
])

// 应追踪会话生命周期的事件（不产生通知，仅更新会话状态）
const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.deleted",
])

const plugin: Plugin = async (_input, options) => {
  // 确保配置文件存在（不存在则生成默认模板）
  ensureConfigFile()

  // 加载 YAML 配置 + 合并 plugin options
  const yamlCfg = loadYamlConfig() ?? {}
  const merged = mergeConfig(yamlCfg, options as PluginConfig ?? {})
  const cfg = resolveConfig(merged)
  if (cfg.debug_log) enableDebug()
  const store = new FileStore()
  const senders = buildSenders(cfg)
  const dispatcher = new Dispatcher(store, cfg.dedupe_seconds ?? 60, senders)

  // 会话感知抑制
  const tracker = new SessionTracker(cfg.session_stale_timeout_ms)

  log(`插件已加载, debug_log=${cfg.debug_log}, events=${JSON.stringify(cfg.events)}, `
    + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout_ms}ms, `
    + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}`)

  return {
    // event 总线 — 所有事件通过此钩子
    event: async ({ event }) => {
      const { type, properties } = event as any
      const propKeys = properties ? Object.keys(properties).join(",") : ""

      // 调试日志：记录所有事件（随时可关闭）
      log(`[event] type=${type} keys=${propKeys}`)

      const sessionID = properties?.sessionID ?? "unknown"

      // === 更新会话追踪状态 ===

      // 用户操作事件 → 标记该会话活跃
      if (USER_ACTIVITY_EVENTS.has(type)) {
        tracker.markActivity(sessionID)
        log(`→ 用户活跃事件, 会话=${sessionID}`)
      }

      // 会话生命周期事件
      if (type === "session.created") {
        tracker.register(sessionID)
        log(`→ 会话已创建, 会话=${sessionID}`)
      }
      if (type === "session.deleted") {
        tracker.remove(sessionID)
        log(`→ 会话已删除, 会话=${sessionID}`)
      }

      // === 通知判定 ===

      const suppressEvents = cfg.suppress_events_when_active ?? []

      // 先路由事件，看是否匹配通知
      const msg = route(event, cfg.events)
      if (!msg) return  // 不关心的事件

      log(`→ 匹配通知: ${msg.event}`)

      // 会话感知抑制判定
      if (cfg.suppress_when_active && suppressEvents.includes(msg.event)) {
        const active = tracker.isSessionActive(sessionID, cfg.activity_timeout_ms ?? 15000)
        if (active) {
          log(`→ 会话 ${sessionID} 活跃中，跳过通知 (${msg.event})`)
          return
        }
      }

      // 调度发送
      await dispatcher.dispatch(msg)
    },
  }
}

function addSender(
  senders: import("./senders/types.js").Sender[],
  sender: import("./senders/types.js").Sender,
  events: string[],
  label: string,
  extra?: string,
) {
  senders.push(new FilteredSender(sender, events))
  const evt = events.length < 6 ? `events=${JSON.stringify(events)}` : `events=${events.length}个`
  log(`${label}已启用 (${evt})${extra ? `, ${extra}` : ""}`)
}

function buildSenders(cfg: PluginConfig) {
  const senders: import("./senders/types.js").Sender[] = []
  const globalEvents = cfg.events ?? []

  if (cfg.channels?.system_message?.enabled) {
    const events = cfg.channels.system_message.events ?? globalEvents
    addSender(senders, new SystemSender(), events, "系统通知")
  }
  if (cfg.channels?.screen_flash?.enabled) {
    const events = cfg.channels.screen_flash.events ?? globalEvents
    addSender(senders, new ScreenFlashSender(cfg.channels.screen_flash), events, "屏幕跑马灯")
  }
  if (cfg.channels?.custom_webhook?.enabled && cfg.channels.custom_webhook.url) {
    const events = cfg.channels.custom_webhook.events ?? globalEvents
    addSender(senders, new CustomWebhookSender(cfg.channels.custom_webhook), events, "自定义 Webhook")
  }
  if (cfg.channels?.wechat_work?.enabled && cfg.channels.wechat_work.webhook_url) {
    const events = cfg.channels.wechat_work.events ?? globalEvents
    addSender(senders, new WechatWorkSender(cfg.channels.wechat_work), events, "企业微信")
  }
  if (cfg.channels?.feishu?.enabled && cfg.channels.feishu.webhook_url) {
    const events = cfg.channels.feishu.events ?? globalEvents
    addSender(senders, new FeishuSender(cfg.channels.feishu), events, "飞书")
  }
  return senders
}

export default plugin
