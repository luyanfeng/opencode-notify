import { Plugin } from "@opencode/plugin"
import type { PluginConfig, ResolvedPluginConfig } from "./config.js"
import { resolveConfig, loadYamlConfig, mergeConfig, ensureConfigFile } from "./config.js"
import { route } from "./events.js"
import type { V2Event } from "./events.js"
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
import type { OpencodeBridge } from "./control/types.js"
import { NtfyNotifySender } from "./senders/ntfy.js"
import { GotifyNotifySender } from "./senders/gotify.js"

// 用户活跃事件类型（这些事件表明用户正在操作 opencode 的某个会话）
// V2 里 `command.executed` 已消失，命令提交统一走 `session.inbox.enqueued`
const USER_ACTIVITY_EVENTS = new Set([
  "session.inbox.enqueued",
  "permission.replied",
  "form.replied",
  "tui.command.execute",
])


export default Plugin.define({
  id: "opencode-notify",
  async setup(ctx) {
    try {
      // 确保配置文件存在（不存在则生成默认模板）
      ensureConfigFile()

      // 加载 YAML 配置 + 合并 plugin options
      const yamlCfg = loadYamlConfig() ?? {}
      const merged = mergeConfig(yamlCfg, (ctx.options ?? {}) as PluginConfig)
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
      //
      // V2 不再需要 V1 时代"从注入 client 提取 fetch/headers 自建 SDK client"那套：
      // 插件 ctx 直接给 permission / session 域，这里收敛成一个窄桥接接口。
      const bridge: OpencodeBridge = {
        replyPermission: (i) => ctx.permission.reply(i),
        // ⚠️ opencode 2.x 的插件 ctx **没有暴露 form 域**：宿主构造 ctx 用的是白名单对象
        // 字面量，session 域只有 hook/create/get/switchAgent/switchModel/prompt/generate/
        // command/synthetic/interrupt/update/move/wait/context。服务端 session.form.reply
        // 端点存在（TUI 在用），但插件调不到，所以 question 工具建的 form 无法从手机应答。
        // 这里显式抛错而不是静默：用户点按钮会收到明确回执，而不是石沉大海。
        // 一旦 opencode 把 form 暴露进 ctx，把这里换成 ctx.session.form.reply 即可，
        // control/ 层无需改动（OpencodeBridge 签名就是 V2 的 SessionFormReplyInput）。
        replyForm: () => {
          throw new Error(
            "opencode 2.x 插件 ctx 未暴露表单应答接口（session.form.reply），"
            + "无法从手机应答提问；请回电脑处理",
          )
        },
        prompt: async (i) => { await ctx.session.prompt(i) },
        interrupt: async (i) => { await ctx.session.interrupt(i) },
      }
      const replyCfg = cfg.channels.ntfy?.reply ?? cfg.channels.gotify?.reply
      const control = replyCfg ? new ControlController(replyCfg, bridge) : undefined
      control?.start()

      info(`插件已加载 host=${ctx.app.name}@${ctx.app.version} log_level=${cfg.log?.level}, events=${JSON.stringify(cfg.events)}, `
        + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout ?? 60}s, `
        + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}, `
        + `remote_channels=${JSON.stringify(delayedChannels)}, `
        + `terminator_detect=${!!process.env.TERMINATOR_UUID}`)
      if (control) {
        warn("control: opencode 2.x 插件 ctx 无 form 域，提问（answer/select）无法从手机应答，"
          + "点按会收到明确失败回执；权限应答与 say/stop/status 不受影响")
      }

      /**
       * 通知收尾：子会话过滤 → 会话活跃抑制 → 派发 → 延迟推送
       */
      const finishNotification = async (msg: Message, sessionID: string): Promise<void> => {
        // 子会话（background task）：只保留授权/提问通知，完成/取消/失败均静默
        if (tracker.isBackground(sessionID) && msg.event !== "permission_required") {
          debug(`→ 子会话(background task) ${sessionID} 跳过通知 (${msg.event})`)
          return
        }

        // 会话感知抑制判定
        const suppressEvents = cfg.suppress_events_when_active ?? []
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
      }

      /**
       * 单个事件的完整处理链路
       *
       * V2 事件形状为 `{ type, data }`（V1 是 `{ type, properties }`），
       * 全部字段访问都走 `data`。
       */
      const handleEvent = async (event: V2Event): Promise<void> => {
        const type = event.type
        try {
          const data = event.data ?? {}
          const dataKeys = Object.keys(data).join(",")

          // 调试日志：记录所有事件
          debug(`[event] type=${type} keys=${dataKeys}`)

          const sessionID = (data.sessionID as string) ?? "unknown"

          // === 更新会话追踪状态 ===

          // 用户操作事件 → 标记该会话活跃 + 取消延迟通知
          if (USER_ACTIVITY_EVENTS.has(type)) {
            tracker.markActivity(sessionID)
            delayedDispatcher?.cancelForSession(sessionID)
            debug(`→ 用户活跃事件, 会话=${sessionID}`)
          }

          // 权限被回应（含 TUI 内操作）→ 清理待处理，避免手机重复应答
          if (type === "permission.replied") {
            const reqID = String(data.requestID ?? "")
            if (reqID) control?.resolvePending(reqID)
          }

          // 表单被回应/取消 → 按 formID 精确清理（V2 的 data.id 就是 formID）
          if (type === "form.replied" || type === "form.cancelled") {
            const formID = String(data.id ?? "")
            if (formID) control?.resolvePending(formID)
          }

          // session.text.delta — 助手回复增量（V2 取代 V1 的 message.part.updated）。
          // data.delta 是**增量片段**（V1 的 part.text 是全量），按 assistantMessageID
          // 分桶追加；reasoning 走独立的 session.reasoning.* 事件，天然排除。
          if (type === "session.text.delta") {
            const delta = data.delta
            const messageID = data.assistantMessageID
            if (delta && messageID) {
              tracker.appendAssistantText(sessionID, String(messageID), String(delta))
            }
          }

          // session.inbox.enqueued — 用户新输入：记录输入并冻结当前助手回复
          if (type === "session.inbox.enqueued") {
            const item = data.item as { type?: string; payload?: { text?: string } } | undefined
            if (item?.type === "user" && item.payload?.text) {
              const text = String(item.payload.text).trim()
              debug(`→ session.inbox.enqueued: 会话=${sessionID}, 输入="${text.slice(0, 200)}"`)
              tracker.setUserPrompt(sessionID, text.slice(0, 1000))
            }
            tracker.freezeAssistantSummary(sessionID)
          }

          // session.idle — 会话空闲时冻结助手回复
          if (type === "session.idle") {
            tracker.freezeAssistantSummary(sessionID)
          }

          // 会话生命周期事件（V2 把 V1 的 session.updated 拆成专用事件）
          if (type === "session.created") {
            const parentID = data.parentID as string | undefined
            tracker.register(sessionID, parentID)
            const title = data.title as string | undefined
            if (title) tracker.updateTopic(sessionID, title)
            debug(`→ 会话已创建, 会话=${sessionID}${parentID ? ` parent=${parentID}` : ""}`)
          }
          if (type === "session.renamed") {
            const topic = String(data.title ?? "")
            tracker.updateTopic(sessionID, topic)
            debug(`→ 会话已改名, 会话=${sessionID}${topic ? ` topic="${topic}"` : ""}`)
          }
          if (type === "session.deleted") {
            tracker.remove(sessionID)
            control?.forgetSession(sessionID)
            // 不取消延迟推送：会话删除（包括 opencode 自动清理）不代表用户已看到通知
            debug(`→ 会话已删除, 会话=${sessionID}`)
          }

          // 跟踪会话状态
          if (type === "session.status") {
            const st = (data.status as { type?: string } | undefined)?.type
            if (st) tracker.updateStatus(sessionID, st)
            debug(`→ 会话状态更新, 会话=${sessionID} status=${st ?? "?"}`)
          }
          if (type === "session.idle") {
            tracker.updateStatus(sessionID, "idle")
            debug(`→ 会话空闲, 会话=${sessionID}`)
          }

          // === 通知判定 ===

          // 先路由事件，看是否匹配通知（run_failed / run_cancelled 由原生事件驱动）
          let msg = route(event, cfg.events)

          // idle 事件：由会话状态机处理 run_completed。
          // 注：V2 另有原生 `session.execution.succeeded`，但它按 session 的 execution
          // 结算，未验证是否等价于这里"所有子会话都跑完"的语义，故保留已验证的状态机。
          const isIdle = type === "session.idle"
            || (type === "session.status" && (data.status as { type?: string } | undefined)?.type === "idle")

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

          // 注入会话主题、用户输入和助手回复（分桶累积的最后一条消息完整尾部）
          const sessionTopic = tracker.getSessionTopic(sessionID)
          const userPrompt = tracker.getUserPrompt(sessionID)
          const assistantSummary = tracker.getAssistantText(sessionID)
          if (assistantSummary) info(`→ 通知输出摘要: "${assistantSummary.slice(0, 100)}"`)
          enrich(msg, sessionTopic, userPrompt, assistantSummary)

          // 远程控制：所有通知附带会话码（供 say/stop 精确寻址）；
          // 权限/表单额外登记一次性令牌并生成 ntfy 按钮（点按即回传命令）。
          // 注意：events.ts 把 form.created 也映射为 permission_required，
          // 因此必须按原始 type 区分，不能只看 msg.event。
          if (control) {
            if (type === "form.created") {
              // V2 的 form.created：data = { form: FormInfo }，会话 ID 在 form.sessionID 里
              const form = (data.form ?? {}) as {
                id?: string
                sessionID?: string
                title?: string
                fields?: Array<{ key?: string; options?: Array<{ label?: string; value?: string }> }>
              }
              const reqID = String(form.id ?? "")
              if (reqID) {
                const formSessionID = String(form.sessionID ?? sessionID)
                // 选项取自第一个带 options 数组的字段（opencode question 工具的字段 key 为 q0/q1/…）：
                // label 用于显示，value 才是提交给宿主的真实值（两者可能不同）。
                // ⚠️ 必须在**同一次遍历**里同时产出两数组——select/按钮按下标取回传值，
                //    一旦这里出现长度不一致的过滤，下标就会错位、提交错答案。
                const optField = form.fields?.find((f) => Array.isArray(f.options) && f.options.length > 0)
                const options: string[] = []
                const optionValues: string[] = []
                for (const opt of optField?.options ?? []) {
                  const label = String(opt?.label ?? "")
                  if (!label) continue
                  options.push(label)
                  optionValues.push(String(opt?.value ?? label))
                }
                const item = control.registerPending(
                  "form", reqID, formSessionID, String(form.title ?? "提问"),
                  options, { answerKey: optField?.key, optionValues },
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  // 选项 ≥3 时按钮放不下（ntfy 硬限 3 个），必须在正文列出编号供数字回复
                  if (options.length >= 3) {
                    msg.body += "\n选项：\n" + options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
                  }
                  msg.body += `\n令牌：${item.code}`
                  msg.replyHint = options.length > 0
                    ? `📱 回复: select <令牌> 1~${options.length}=选选项 · answer <令牌> 文本`
                    : "📱 回复: answer <令牌> 文本"
                }
                // 每条提问都是独立请求：去重 key 含 formID，避免同会话连续提问被吞
                msg.dedupeKey = `opencode:form:${reqID}`
                // 会话码用 form 自带的会话 ID（form.created 的 data.sessionID 不存在）
                const sc = control.sessionCode(formSessionID)
                if (sc) msg.body += `\n会话码：${sc}`
                // 用 form 真实会话判定子会话（data.sessionID 缺失，不能复用上面的 sessionID）
                return await finishNotification(msg, formSessionID)
              }
            } else if (type === "permission.asked") {
              const reqID = String(data.id ?? "")
              if (reqID) {
                const item = control.registerPending(
                  "permission", reqID, sessionID, String(data.action ?? "权限请求"),
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  msg.body += `\n令牌：${item.code}`
                  msg.replyHint = "📱 回复: approve/deny/always <令牌>"
                }
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

          await finishNotification(msg, sessionID)
        } catch (e) {
          error(`事件处理异常 type=${type}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 事件订阅。V2 的 ctx.event.subscribe(options?) 返回 AsyncIterable<Event>，
      // options 是 RequestOptions（{ signal, headers, onActivity }），卸载时用它断开循环。
      const abort = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            await handleEvent(event)
          }
        } catch (e) {
          // 订阅流中断即视为插件失效，明确暴露而不静默重试
          if (!abort.signal.aborted) {
            error(`事件订阅异常: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      })()

      // 清理：停控制通道 + 断开事件订阅
      return () => {
        abort.abort()
        control?.stop()
      }
    } catch (e) {
      error(`插件初始化失败: ${e instanceof Error ? e.message : String(e)}`)
      // 初始化失败直接结束 setup（返回 undefined）：此时事件循环尚未启动，
      // 不会出现"处理函数未定义"之类的二次异常。
    }
  },
})

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
