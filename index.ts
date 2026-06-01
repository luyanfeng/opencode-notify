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
import { configureLog, error, warn, info, debug } from "./log.js"
import { DelayedDispatcher } from "./delayed-dispatcher.js"
import { isTerminalOccluded } from "./terminator-detect.js"

// 用户活跃事件类型（这些事件表明用户正在操作 opencode 的某个会话）
const USER_ACTIVITY_EVENTS = new Set([
  "message.updated",
  "permission.replied",
  "question.replied",
  "command.executed",
  "tui.command.execute",
])

// 应追踪会话生命周期的事件（不产生通知，仅更新会话状态）
// 直接在内联 if 中判断，无需常量


const plugin: Plugin = async (_input, options) => {
  // 确保配置文件存在（不存在则生成默认模板）
  ensureConfigFile()

  // 加载 YAML 配置 + 合并 plugin options
  const yamlCfg = loadYamlConfig() ?? {}
  const merged = mergeConfig(yamlCfg, options as PluginConfig ?? {})
  const cfg = resolveConfig(merged)
  configureLog(cfg.log?.level as any ?? "info", cfg.log?.file)
  const store = new FileStore()

  // 构建发送器
  const { senders, senderMap } = buildSenders(cfg)
  const dispatcher = new Dispatcher(store, cfg.dedupe_seconds ?? 60, senders)

  // 远程延迟推送
  const delayedChannels = cfg.remote_delay_channels ?? []
  const delayedDispatcher = delayedChannels.length > 0
    ? new DelayedDispatcher(
        (cfg.remote_delay_seconds ?? 60) * 1000,
        cfg.remote_delay_max_count ?? 3,
        delayedChannels,
        senderMap,
      )
    : undefined

  // 会话感知抑制
  const tracker = new SessionTracker(cfg.session_stale_timeout_ms)

  info(`插件已加载, log_level=${cfg.log?.level}, events=${JSON.stringify(cfg.events)}, `
    + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout_ms}ms, `
    + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}, `
    + `remote_channels=${JSON.stringify(delayedChannels)}, `
    + `terminator_detect=${!!process.env.TERMINATOR_UUID}`)

  return {
    // event 总线 — 所有事件通过此钩子
    event: async ({ event }) => {
      const { type, properties } = event as any
      const propKeys = properties ? Object.keys(properties).join(",") : ""

      // 调试日志：记录所有事件
      debug(`[event] type=${type} keys=${propKeys}`)

      const sessionID = properties?.sessionID ?? "unknown"

      // === 更新会话追踪状态 ===

      // 用户操作事件 → 标记该会话活跃 + 取消延迟通知
      if (USER_ACTIVITY_EVENTS.has(type)) {
        tracker.markActivity(sessionID)
        delayedDispatcher?.cancelForSession(sessionID)
        debug(`→ 用户活跃事件, 会话=${sessionID}`)
      }

      // 会话生命周期事件
      if (type === "session.created") {
        tracker.register(sessionID)
        debug(`→ 会话已创建, 会话=${sessionID}`)
      }
      if (type === "session.deleted") {
        tracker.remove(sessionID)
        delayedDispatcher?.cancelForSession(sessionID)
        debug(`→ 会话已删除, 会话=${sessionID}`)
      }

      // === 通知判定 ===

      const suppressEvents = cfg.suppress_events_when_active ?? []

      // 先路由事件，看是否匹配通知
      const msg = route(event, cfg.events)
      if (!msg) return  // 不关心的事件

      debug(`→ 匹配通知: ${msg.event}`)

      // 会话感知抑制判定
      let shouldSuppress = cfg.suppress_when_active && suppressEvents.includes(msg.event)
        && tracker.isSessionActive(sessionID, cfg.activity_timeout_ms ?? 15000)

      // Terminator 子屏遮挡覆盖：会话活跃但如果本屏被遮挡 → 强制通知
      if (shouldSuppress) {
        const occluded = isTerminalOccluded()
        if (occluded === true) {
          info(`→ 会话 ${sessionID} 活跃但 Terminator 子屏被遮挡，强制通知 (${msg.event})`)
          shouldSuppress = false
        } else if (occluded === false) {
          debug(`→ Terminator 子屏未遮挡，正常抑制`)
        }
        // null = 不在 Terminator 或检测失败，不处理
      }

      if (shouldSuppress) {
        info(`→ 会话 ${sessionID} 活跃中，跳过通知 (${msg.event})`)
        return
      }

      // 调度发送（正常立即通知）
      await dispatcher.dispatch(msg)

      // 正常通知已发出 → 调度远程延迟推送（如果启用）
      delayedDispatcher?.schedule(msg)
    },
  }
}

/** buildSenders 返回值 */
interface BuildSendersResult {
  senders: import("./senders/types.js").Sender[]
  senderMap: Map<string, import("./senders/types.js").Sender>
}

function addSender(
  senders: import("./senders/types.js").Sender[],
  sender: import("./senders/types.js").Sender,
  events: string[],
  label: string,
  extra?: string,
): import("./senders/types.js").Sender {
  const filtered = new FilteredSender(sender, events)
  senders.push(filtered)
  const evt = events.length < 6 ? `events=${JSON.stringify(events)}` : `events=${events.length}个`
  info(`${label}已启用 (${evt})${extra ? `, ${extra}` : ""}`)
  return filtered
}

function buildSenders(cfg: PluginConfig): BuildSendersResult {
  const senders: import("./senders/types.js").Sender[] = []
  const senderMap = new Map<string, import("./senders/types.js").Sender>()
  const globalEvents = cfg.events ?? []

  if (cfg.channels?.system_message?.enabled) {
    const events = cfg.channels.system_message.events ?? globalEvents
    const s = addSender(senders, new SystemSender(), events, "系统通知")
    senderMap.set("system_message", s)
  }
  if (cfg.channels?.screen_flash?.enabled) {
    const events = cfg.channels.screen_flash.events ?? globalEvents
    const s = addSender(senders, new ScreenFlashSender(cfg.channels.screen_flash), events, "屏幕跑马灯")
    senderMap.set("screen_flash", s)
  }
  if (cfg.channels?.custom_webhook?.enabled && cfg.channels.custom_webhook.url) {
    const events = cfg.channels.custom_webhook.events ?? globalEvents
    const s = addSender(senders, new CustomWebhookSender(cfg.channels.custom_webhook), events, "自定义 Webhook")
    senderMap.set("custom_webhook", s)
  }
  if (cfg.channels?.wechat_work?.enabled && cfg.channels.wechat_work.webhook_url) {
    const events = cfg.channels.wechat_work.events ?? globalEvents
    const s = addSender(senders, new WechatWorkSender(cfg.channels.wechat_work), events, "企业微信")
    senderMap.set("wechat_work", s)
  }
  if (cfg.channels?.feishu?.enabled && cfg.channels.feishu.webhook_url) {
    const events = cfg.channels.feishu.events ?? globalEvents
    const s = addSender(senders, new FeishuSender(cfg.channels.feishu), events, "飞书")
    senderMap.set("feishu", s)
  }
  return { senders, senderMap }
}

export default plugin
