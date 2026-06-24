import type { Plugin } from "@opencode-ai/plugin"
import type { PluginConfig } from "./config.js"
import { resolveConfig, loadYamlConfig, mergeConfig, ensureConfigFile } from "./config.js"
import { route } from "./events.js"
import { enrich, formatTitle, defaultBody, formatBody } from "./message.js"
import type { Message } from "./message.js"
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
  try {
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
      + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout ?? 60}s, `
      + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}, `
      + `remote_channels=${JSON.stringify(delayedChannels)}, `
      + `terminator_detect=${!!process.env.TERMINATOR_UUID}`)

    return {
      /**
       * chat.message — 用户发送新消息时回调
       * 从 parts 中提取 TextPart.text 作为用户输入内容
       */
      "chat.message": async (_input, output) => {
        const { message, parts } = output
        const sessionID = message.sessionID
        if (!sessionID || message.role !== "user") return

        const textParts = parts.filter(p => p.type === "text" && !p.synthetic)
        const userText = textParts.map(p => (p as any).text ?? "").filter(Boolean).join("\n")
        if (userText) {
          debug(`→ chat.message: 会话=${sessionID}, 输入="${userText.slice(0, 200)}"`)
          tracker.setUserPrompt(sessionID, userText.slice(0, 1000))
        }
      },

      // event 总线 — 所有事件通过此钩子
      event: async ({ event }) => {
        let type = ""
        try {
          const parsed = event as any
          type = parsed.type ?? ""
          const properties = parsed.properties
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
            const parentID = properties.info?.parentID
            tracker.register(sessionID, parentID)
            debug(`→ 会话已创建, 会话=${sessionID}${parentID ? ` parent=${parentID}` : ""}`)
          }
          if (type === "session.updated") {
            const topic = properties.info?.title
            tracker.updateTopic(sessionID, topic)
            debug(`→ 会话已更新, 会话=${sessionID}${topic ? ` topic="${topic}"` : ""}`)
          }
          if (type === "session.deleted") {
            tracker.remove(sessionID)
            // 不取消延迟推送：会话删除（包括 opencode 自动清理）不代表用户已看到通知
            debug(`→ 会话已删除, 会话=${sessionID}`)
          }

          // 跟踪会话状态
          if (type === "session.status") {
            const st = properties.status?.type
            if (st) tracker.updateStatus(sessionID, st)
            debug(`→ 会话状态更新, 会话=${sessionID} status=${st ?? "?"}`)
          }
          if (type === "session.idle") {
            tracker.updateStatus(sessionID, "idle")
            debug(`→ 会话空闲, 会话=${sessionID}`)
          }

          // === 通知判定 ===

          const suppressEvents = cfg.suppress_events_when_active ?? []

          // 先路由事件，看是否匹配通知
          let msg = route(event, cfg.events)

          // idle 事件：由会话状态机处理 run_completed
          const isIdle = type === "session.idle"
            || (type === "session.status" && properties?.status?.type === "idle")

          if (!msg && isIdle) {
            if (cfg.events?.includes("run_completed")) {
              // 子会话 idle → 跳过（background task 完成，静默）
              if (tracker.isBackground(sessionID)) {
                debug(`→ 子会话 ${sessionID} idle, 跳过`)
                return
              }
              // 主会话 idle 但仍有子会话在跑 → 跳过
              if (tracker.hasActiveChildren(sessionID)) {
                debug(`→ 主会话 ${sessionID} idle 但子会话活跃中, 跳过`)
                return
              }
              // 全部任务完成 → run_completed
              debug(`→ 全部任务完成 (${sessionID}), 发送 run_completed`)
              msg = {
                agent: "opencode",
                event: "run_completed",
                sessionID,
                title: formatTitle("run_completed"),
                body: defaultBody("run_completed"),
              }
              msg.body = formatBody(msg)
            }
            if (!msg) return  // run_completed 未启用或未匹配
          } else if (!msg) {
            return  // 其他不关心的事件
          }

          // 注入会话主题和用户输入，增强通知内容
          const sessionTopic = tracker.getSessionTopic(sessionID)
          const userPrompt = tracker.getUserPrompt(sessionID)
          enrich(msg, sessionTopic, userPrompt)

          debug(`→ 匹配通知: ${msg.event} topic="${sessionTopic ?? ""}" prompt="${(userPrompt ?? "").slice(0, 80)}"`)

          // 子会话（background task）：非失败事件跳过，失败仍通知
          // run_completed 已在上层排除子会话，此处的 isBackground 只对 route 事件生效
          if (tracker.isBackground(sessionID) && msg.event !== "run_failed") {
            debug(`→ 子会话(background task) ${sessionID} 跳过通知 (${msg.event})`)
            return
          }

          // 会话感知抑制判定
          let shouldSuppress = cfg.suppress_when_active && suppressEvents.includes(msg.event)
            && tracker.isSessionActive(sessionID, (cfg.activity_timeout ?? 60) * 1000)

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
            info(`→ 会话 ${sessionID} 活跃中，跳过即时通知 (${msg.event})`)
            // 仍调度延迟推送：用户可能在电脑前屏上可见所以抑制，
            // 但万一用户已离开电脑，延迟推送能在用户未回来时再次提醒
            delayedDispatcher?.schedule(msg)
            return
          }

          // 调度发送（正常立即通知）
          await dispatcher.dispatch(msg)

          // 正常通知已发出 → 调度远程延迟推送（如果启用）
          delayedDispatcher?.schedule(msg)
        } catch (e) {
          error(`事件处理异常 type=${type}: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    }
  } catch (e) {
    error(`插件初始化失败: ${e instanceof Error ? e.message : String(e)}`)
    // 初始化失败仍返回空 hook，避免 opencode 加载插件时崩溃
    return { event: async () => {} }
  }
}

/** buildSenders 返回值 */
interface BuildSendersResult {
  senders: import("./senders/types.js").Sender[]
  senderMap: Map<string, import("./senders/types.js").Sender>
}

function buildSenders(cfg: PluginConfig): BuildSendersResult {
  const senders: import("./senders/types.js").Sender[] = []
  const senderMap = new Map<string, import("./senders/types.js").Sender>()
  const globalEvents = cfg.events ?? []

  /**
   * 注册渠道发送器
   * @param key      渠道键名
   * @param mode     渠道模式
   * @param chEvents 渠道级事件过滤
   * @param create   创建原始 Sender 的回调
   * @param label    日志标签
   */
  function register(
    key: string,
    mode: string | undefined,
    chEvents: string[] | undefined,
    create: () => import("./senders/types.js").Sender,
    label: string,
  ): void {
    if (mode === "none" || !mode) return  // 禁用

    const evts = chEvents ?? globalEvents
    const raw = create()
    const filtered = new FilteredSender(raw, evts)

    if (mode === "delay_only") {
      // 仅延迟推送：不进 senders[]，只入 senderMap
      senderMap.set(key, filtered)
      info(`${label}已启用 (delay_only, 仅延迟推送)`)
    } else {
      // all：即时通知 + 延迟推送
      senders.push(filtered)
      senderMap.set(key, filtered)
      const evtStr = evts.length < 6 ? `events=${JSON.stringify(evts)}` : `events=${evts.length}个`
      info(`${label}已启用 (${evtStr})`)
    }
  }

  const ch = cfg.channels
  register("system_message", ch?.system_message?.mode, ch?.system_message?.events,
    () => new SystemSender(), "系统通知")
  register("screen_flash", ch?.screen_flash?.mode, ch?.screen_flash?.events,
    () => new ScreenFlashSender(ch?.screen_flash ?? { mode: "none" }), "屏幕跑马灯")
  register("custom_webhook", ch?.custom_webhook?.mode, ch?.custom_webhook?.events,
    () => new CustomWebhookSender(ch?.custom_webhook ?? { mode: "none" }), "自定义 Webhook")
  register("wechat_work", ch?.wechat_work?.mode, ch?.wechat_work?.events,
    () => new WechatWorkSender(ch?.wechat_work ?? { mode: "none" }), "企业微信")
  register("feishu", ch?.feishu?.mode, ch?.feishu?.events,
    () => new FeishuSender(ch?.feishu ?? { mode: "none" }), "飞书")

  return { senders, senderMap }
}

export default plugin
