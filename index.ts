import type { Plugin } from "@opencode-ai/plugin"
import type { PluginConfig, ResolvedPluginConfig } from "./config.js"
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
import { ControlController } from "./control/controller.js"
import { NtfyNotifySender } from "./senders/ntfy.js"
import { GotifyNotifySender } from "./senders/gotify.js"

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
    const logLevel: import("./log.js").LogLevel = ["off", "error", "warn", "info", "debug"].includes(cfg.log?.level ?? "")
      ? (cfg.log?.level as import("./log.js").LogLevel)
      : "info"
    configureLog(logLevel, cfg.log?.file)
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

    // 远程控制通道（手机 → 插件 → opencode 应答；全部出站连接）
    // reply 配置挂在通知渠道下（channels.ntfy.reply / channels.gotify.reply），
    // 二者互斥取其一（同一进程只启动一个命令通道）。
    const replyCfg = cfg.channels.ntfy?.reply ?? cfg.channels.gotify?.reply
    const control = replyCfg
      ? new ControlController(
          replyCfg,
          String(_input.serverUrl ?? ""),
          _input.directory,
          // 传入 opencode 注入的 client（v1，含底层内存 fetch + 认证头）。
          // 控制器会从中提取 fetch/headers 构造 v2 client，兼容直跑与 server 两种模式。
          _input.client,
        )
      : undefined
    control?.start()

    info(`插件已加载, log_level=${cfg.log?.level}, events=${JSON.stringify(cfg.events)}, `
      + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout ?? 60}s, `
      + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}, `
      + `remote_channels=${JSON.stringify(delayedChannels)}, `
      + `terminator_detect=${!!process.env.TERMINATOR_UUID}`)

    return {
      /**
       * 插件卸载/进程退出时清理控制通道定时器
       */
      dispose: async () => {
        control?.stop()
      },
      /**
       * chat.message — 用户发送新消息时回调
       * 从 parts 中提取 TextPart.text
       * - role=user：记录用户输入
       * - role=assistant：记录助手回复摘要
       */
      "chat.message": async (_input, output) => {
        const { message, parts } = output
        const sessionID = message.sessionID
        if (!sessionID) return

        const textParts = parts.filter(p => p.type === "text" && !p.synthetic)
        const text = textParts.map(p => (p as any).text ?? "").filter(Boolean).join("\n").trim()
        if (!text) return

        if (message.role === "user") {
          debug(`→ chat.message: 会话=${sessionID}, 输入="${text.slice(0, 200)}"`)
          tracker.setUserPrompt(sessionID, text.slice(0, 1000))
        } else if (message.role === "assistant") {
          debug(`→ chat.message: 会话=${sessionID}, 回复="${text.slice(0, 200)}"`)
          tracker.setAssistantSummary(sessionID, text.slice(0, 1000))
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

          // 权限/提问被回应（含 TUI 内操作）→ 清理待处理，避免手机重复应答
          if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
            const reqID = String(properties?.requestID ?? properties?.permissionID ?? "")
            if (reqID) control?.resolvePending(reqID)
          }

          // message.part.updated — 累积助手回复文本（防抖：只记录最后一段的文本片段）
          if (type === "message.part.updated") {
            const part = properties?.part
            if (part?.type === "text" && !part.synthetic && part.text) {
              tracker.appendAssistantText(sessionID, String(part.text))
            }
          }

          // message.updated（role=user）— 用户新输入，冻结当前助手回复
          if (type === "message.updated") {
            const role = properties?.info?.role
            if (role === "user") {
              tracker.freezeAssistantSummary(sessionID)
            }
          }

          // session.idle — 会话空闲时也冻结助手回复
          if (type === "session.idle") {
            tracker.freezeAssistantSummary(sessionID)
          }

          // 会话生命周期事件
          if (type === "session.created") {
            const parentID = properties.info?.parentID
            tracker.register(sessionID, parentID)
            debug(`→ 会话已创建, 会话=${sessionID}${parentID ? ` parent=${parentID}` : ""}`)
          }
          if (type === "session.updated") {
            const topic = properties.info?.title
            const parentID = properties.info?.parentID
            tracker.updateTopic(sessionID, topic)
            // 兜底：若 session.created 未带 parentID，从 session.updated 补记父子关系
            if (parentID) tracker.setParent(sessionID, parentID)
            debug(`→ 会话已更新, 会话=${sessionID}${topic ? ` topic="${topic}"` : ""}`)
          }
          if (type === "session.deleted") {
            tracker.remove(sessionID)
            control?.forgetSession(sessionID)
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

          // 注入会话主题、用户输入和助手摘要，增强通知内容
          const sessionTopic = tracker.getSessionTopic(sessionID)
          const userPrompt = tracker.getUserPrompt(sessionID)
          const assistantSummary = tracker.getAssistantSummary(sessionID)
          if (assistantSummary) info(`→ 通知输出摘要: "${assistantSummary.slice(0, 100)}"`)
          enrich(msg, sessionTopic, userPrompt, assistantSummary)

          // 远程控制：所有通知附带会话码（供 say/stop 精确寻址）；
          // 权限/提问额外登记一次性令牌并生成 ntfy 按钮（点按即回传命令）。
          // 注意：events.ts 把 question.asked 也映射为 permission_required，
          // 因此必须按原始 type 区分，不能只看 msg.event。
          if (control) {
            if (type === "question.asked") {
              const reqID = String(properties?.id ?? properties?.requestID ?? "")
              if (reqID) {
                const q0 = (properties?.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> | undefined)?.[0]
                const options = q0?.options?.map((o) => String(o.label ?? "")).filter(Boolean)
                const item = control.registerPending(
                  "question", reqID, sessionID, String(q0?.question ?? "提问"), options,
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  // 选项 ≥3 时按钮放不下（ntfy 硬限 3 个），必须在正文列出编号供数字回复
                  if (options && options.length >= 3) {
                    msg.body += "\n选项：\n" + options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
                  }
                  msg.body += `\n令牌：${item.code}`
                  msg.replyHint = options && options.length > 0
                    ? `📱 回复: select <令牌> 1~${options.length}=选选项 · answer <令牌> 文本`
                    : "📱 回复: answer <令牌> 文本"
                }
                // 每条提问都是独立请求：去重 key 含 requestID，避免同会话连续提问被吞
                msg.dedupeKey = `opencode:question:${reqID}`
              }
            } else if (type === "permission.asked" || type === "permission.updated") {
              const reqID = String(properties?.id ?? properties?.requestID ?? "")
              if (reqID) {
                const item = control.registerPending(
                  "permission", reqID, sessionID, String(properties?.permission ?? "权限请求"),
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  msg.body += `\n令牌：${item.code}`
                  msg.replyHint = "📱 回复: approve/deny/always <令牌>"}
                msg.dedupeKey = `opencode:permission:${reqID}`
              }
            } else if (msg.event === "run_completed" || msg.event === "run_failed" || msg.event === "run_cancelled") {
              const btns: import("./control/types.js").ControlButton[] = []
              const copy = control.buildSayCopyButton(sessionID)
              if (copy) btns.push(copy)
              btns.push(control.buildStatusButton(sessionID))
              msg.controlButtons = btns
              // 凭证强制协议：所有回复必须带续接令牌（TTL 内可反复 say/stop）
              msg.replyHint = "📱 回复: say <令牌> 文本=继续 · stop <令牌>=中断 · status <令牌>=状态"
            }
            const sc = control.sessionCode(sessionID)
            if (sc) msg.body += `\n会话码：${sc}`
          }

          debug(`→ 匹配通知: ${msg.event} topic="${sessionTopic ?? ""}" prompt="${(userPrompt ?? "").slice(0, 80)}"`)

          // 子会话（background task）：只保留授权/提问通知，完成/取消/失败均静默
          if (tracker.isBackground(sessionID) && msg.event !== "permission_required") {
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

function buildSenders(cfg: ResolvedPluginConfig): BuildSendersResult {
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
  register("wechat_work", ch?.wechat_work?.mode, ch?.wechat_work?.events,
    () => new WechatWorkSender(ch?.wechat_work ?? { mode: "none" }), "企业微信")
  register("feishu", ch?.feishu?.mode, ch?.feishu?.events,
    () => new FeishuSender(ch?.feishu ?? { mode: "none" }), "飞书")

  // ntfy 通知渠道（可选承载操作按钮）
  register("ntfy", ch?.ntfy?.mode, ch?.ntfy?.events,
    () => new NtfyNotifySender(
      ch!.ntfy!.server_url ?? "",
      ch!.ntfy!.topic ?? "",
      ch!.ntfy!.reply?.commandTopic ?? "",
      ch!.ntfy!.token,
      ch!.ntfy!.priority,
      ch!.ntfy!.reply?.commandPriority,
      ch!.ntfy!.reply?.botTag,
    ), "ntfy 通知")

  // gotify 通知渠道（无按钮）
  register("gotify", ch?.gotify?.mode, ch?.gotify?.events,
    () => new GotifyNotifySender(
      ch!.gotify!.server_url ?? "",
      ch!.gotify!.app_token ?? "",
      ch!.gotify!.priority,
    ), "Gotify 通知")

  // 自定义 Webhook：命名多配置，逐个注册（渠道名 = 用户自定义名）
  for (const [name, wh] of Object.entries(ch?.custom_webhook ?? {})) {
    register(name, wh.mode, wh.events,
      () => new CustomWebhookSender(wh), `自定义 Webhook(${name})`)
  }

  return { senders, senderMap }
}

export default plugin
