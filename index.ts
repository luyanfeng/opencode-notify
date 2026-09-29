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
import { ProcessSingleton } from "./process-singleton.js"
import { FormReplyBridge } from "./form-reply-bridge.js"
import {
  registerInstance, unregisterInstance, getInstanceByLocation, listInstanceLocations,
} from "./control/instance-registry.js"
import { PermissionTargetNotOpenError, PermissionAlreadySettledError } from "./control/types.js"
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
      // 表单应答桥（服务端侧）：服务端 ctx 无 form 域，无法直接调 session.form.reply。
      // 改为经 RPC 事件派发给 tui.ts（终端进程），等它回调确认后才判定成败。
      // 详见 form-reply-bridge.ts 与 doc/v2-plugin-form-mechanism.md。
      const formReplyBridge = new FormReplyBridge(cfg.form_reply_timeout_ms)

      // ===== 授权应答按 location 路由（见 control/instance-registry.ts）=====
      // 宿主对 permission.reply 有「按实例 location」的门控：只有实例的 location 等于
      // 会话所属目录时才认。而活动实例（owner）可能属于任意目录，故必须把应答交给
      // **会话所属 location 的实例**去执行。
      const location = ctx.location?.directory ?? "?"

      // 本实例登记自己的最小能力（仅 replyPermission），供其它实例按 location 取用。
      const selfCapability: import("./control/instance-registry.js").InstanceCapability = {
        replyPermission: async (i) => { await ctx.permission.reply(i) },
      }
      registerInstance(location, selfCapability)

      /**
       * 解析会话所属 location：优先用事件带来的值，缺失时查会话兜底
       * （实测 `ctx.session.get` 不受 location 门控，可读其它目录的会话）
       */
      const resolveSessionLocation = async (
        sessionID: string,
        hint?: string,
      ): Promise<string | undefined> => {
        if (hint) return hint
        try {
          const s = await ctx.session.get({ sessionID })
          return (s as unknown as { location?: { directory?: string } })?.location?.directory
        } catch {
          return undefined
        }
      }

      const bridge: OpencodeBridge = {
        // 路由：按会话所属 location 找目标实例 → 以**它的**名义应答
        replyPermission: async (i) => {
          const target = await resolveSessionLocation(i.sessionID, i.locationDirectory)
          if (!target) {
            throw new Error("无法确定该会话所属的项目位置，请稍后重试")
          }
          const cap = getInstanceByLocation(target)
          if (!cap) {
            // 该项目没有实例（从未打开过）→ 明确告知，而不是笼统的"请求不存在"
            throw new PermissionTargetNotOpenError(target)
          }
          // 以目标实例的名义调用：即使它当前不是活动实例也能成功（宿主按 location 门控）
          try {
            await cap.replyPermission({
              sessionID: i.sessionID,
              requestID: i.requestID,
              decision: i.decision,
            })
          } catch (e) {
            // 宿主报「请求不存在」有两种可能：该请求已被处理/取消（最常见），
            // 或目标实例已过期（陈旧引用）。统一转成"已结算"语义，避免用户误以为
            // 自己操作有误或令牌失效 —— 与"项目未打开"也区分开。
            const msg = e instanceof Error ? e.message : JSON.stringify(e)
            if (/not\s*found|not\s*exist/i.test(msg)) {
              throw new PermissionAlreadySettledError(msg)
            }
            throw e
          }
        },
        // 真实投递：emit 请求 → 等 TUI 回调确认 → 成功/失败/超时各有明确结果。
        // 失败与超时都抛错（不静默），由 control/ 层转成回执并保留令牌。
        replyForm: (i) => formReplyBridge.request({
          formID: i.formID,
          sessionID: i.sessionID,
          answer: i.answer,
          locationDirectory: i.locationDirectory,
        }),
        prompt: async (i) => { await ctx.session.prompt(i) },
        interrupt: async (i) => { await ctx.session.interrupt(i) },
      }
      const replyCfg = cfg.channels.ntfy?.reply ?? cfg.channels.gotify?.reply
      const control = replyCfg ? new ControlController(replyCfg, bridge) : undefined



      // 进程级单例：opencode 2.x 每个 location 各加载一份实例，而事件流是 server 级
      // 全局的，同一个事件会被每份实例各处理一次 → 一次事件发 N 条重复通知。
      // 只有活动实例订阅事件 + 发通知 + 跑命令通道，其余实例完全空闲。
      // 规则是「最新注册者夺权」而不是「首个注册者上位 + teardown 交接」：
      // 后者依赖宿主每次重载都调用 cleanup，一旦有例外（只加载新实例而不卸载
      // 旧实例），第一个实例就会一直占着 owner，改配置/改代码都不生效。
      // 夺权制不依赖 cleanup，两种时序都成立。详见 process-singleton.ts。
      // activate 需要引用下方才定义的 handleEvent，这里只能前置声明实例引用。
      let singleton: ProcessSingleton

      info(`插件已加载 host=${ctx.app.name}@${ctx.app.version} log_level=${cfg.log?.level}, events=${JSON.stringify(cfg.events)}, `
        + `suppressActive=${cfg.suppress_when_active}, timeout=${cfg.activity_timeout ?? 60}s, `
        + `suppressEvents=${JSON.stringify(cfg.suppress_events_when_active)}, `
        + `remote_channels=${JSON.stringify(delayedChannels)}, `
        + `terminator_detect=${!!process.env.TERMINATOR_UUID}`)
      if (control) {
        warn("control: 提问应答经 TUI 入口（tui.ts）投递；若终端客户端未运行，应答会超时并如实回执")
        info(`control: 实例已登记 location=${location}，当前登记表=${JSON.stringify(listInstanceLocations())}`)
      }

      /**
       * 通知收尾：子会话过滤 → 会话活跃抑制 → 派发 → 延迟推送
       */
      const finishNotification = async (msg: Message, sessionID: string): Promise<void> => {
        // 非活动实例（已被更新实例夺权 / 待命）：完全不发通知、不排延迟任务，
        // 否则同一个事件会被 N 份实例各发一遍。
        if (!singleton.isActive()) {
          debug(`→ 非活动实例，跳过通知分发 (${msg.event}) 会话=${sessionID}`)
          return
        }

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

          // 远程控制：凭证一律走一次性令牌（`oc-<实例>-<随机>`，完成类为 session 型续接令牌）；
          // 权限/表单额外登记令牌并生成 ntfy 按钮（点按即回传命令）。
          // ⚠️ 会话码 `sc-xxxx` 已从通知正文移除（正文靠 `会话：ses_xxx` 区分会话），故此处不再附带。
          // 注意：events.ts 把 form.created 也映射为 permission_required，
          // 因此必须按原始 type 区分，不能只看 msg.event。
          if (control) {
            if (type === "form.created") {
              // V2 的 form.created：data = { form: FormInfo }，会话 ID 在 form.sessionID 里
              // ⚠️ 真实结构（实测 2.0.19）：form.title 恒为占位 "Questions"，
              //    真正的问题在 fields[i].title + fields[i].description，
              //    每个选项的说明在 fields[i].options[j].description —— 读取时都要带上。
              const form = (data.form ?? {}) as {
                id?: string
                sessionID?: string
                title?: string
                fields?: Array<{
                  key?: string
                  title?: string
                  description?: string
                  options?: Array<{ label?: string; value?: string; description?: string }>
                }>
              }
              const reqID = String(form.id ?? "")
              if (reqID) {
                const formSessionID = String(form.sessionID ?? sessionID)
                // 只用于**正文展示**的长度上限：ntfy 服务端消息硬限 4095 字节，超限直接 500 →
                // 通知彻底丢失（不是静默截断）。这些字段由模型生成、长度不可控，必须先截。
                const clampDisplay = (text: string, limit: number): string =>
                  text.length > limit ? text.slice(0, limit - 3) + "..." : text
                // 选项取自第一个带 options 数组的字段（opencode question 工具的字段 key 为 q0/q1/…）：
                // label 用于显示，value 才是提交给宿主的真实值（两者可能不同）。
                // ⚠️ 必须在**同一次遍历**里同时产出三数组——select/按钮按下标取回传值，
                //    一旦这里出现长度不一致的过滤，下标就会错位、提交错答案。
                //    选项说明（options[].description）只进**正文展示**，绝不进 optionValues，
                //    因此不影响提交给宿主的真实值。
                // ⚠️ 这里的 label 一律**原样**入 options（按钮标签与「已回答 X」回执用），
                //    截断只发生在拼正文那一步，绝不改动三个数组的内容。
                const optField = form.fields?.find((f) => Array.isArray(f.options) && f.options.length > 0)
                const options: string[] = []
                const optionValues: string[] = []
                const optionDescs: string[] = []
                for (const opt of optField?.options ?? []) {
                  const label = String(opt?.label ?? "")
                  if (!label) continue
                  options.push(label)
                  optionValues.push(String(opt?.value ?? label))
                  optionDescs.push(String(opt?.description ?? ""))
                }
                // 真问题：优先取 fields 里第一个带 title 的字段（form.title 只是占位 "Questions"），
                // 补充说明取同字段的 description，最后才用 form.title 兜底。
                const questionField =
                  form.fields?.find((f) => String(f?.title ?? "").trim() !== "") ?? optField
                const questionTitle = clampDisplay(String(questionField?.title ?? "").trim(), 100)
                const questionDesc = clampDisplay(String(questionField?.description ?? "").trim(), 200)
                const questionText = questionTitle || questionDesc || String(form.title ?? "").trim()
                const item = control.registerPending(
                  "form", reqID, formSessionID, questionText || "提问",
                  options, {
                    answerKey: optField?.key,
                    optionValues,
                    // 位置（主判据）：form.created 事件顶层带 location.directory。
                    // 应答时带给 TUI，只有归属该位置的终端客户端才投递。
                    locationDirectory: event.location?.directory,
                  },
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  // 把占位的「输入：需要确认: Questions」换成真问题：
                  // 「输入」= fields[i].description（补充说明，缺失则退回真问题标题），
                  // 另起「问题」行放 fields[i].title（真问题标题）。两者都显示。
                  // ⚠️ 替换串一律用**函数形式**：字符串形式会解释 $&/$`/$'/$$，
                  //    而 inputLine 来自模型生成（shell 提示符、$(...)、代码片段都很常见），
                  //    一旦命中就是正文被撑爆/内容错乱。函数形式不做 $ 展开。
                  const inputLine = questionDesc || questionTitle || "请做出选择"
                  msg.body = msg.body.replace(/^\*\*输入：\*\*.*$/m, () => `**输入：** ${inputLine}`)
                  // ⚠️ 与 inputLine 比（不是与 questionDesc 比）：字段只有 title 没有 description
                  //    时 inputLine 就是 questionTitle，用 desc 比会漏判 → 同一句话出现两次。
                  if (questionTitle && questionTitle !== inputLine) {
                    msg.body = msg.body.replace(/^\*\*输入：\*\*.*$/m, (line) => `${line}\n**问题：** ${questionTitle}`)
                  }
                  // 选项一律写进正文，按钮只是快捷方式。
                  // ⚠️ 不要图省事只在 ≥3 个时才列：ntfy 硬限 3 个 action，1~2 个选项时
                  //    按钮能盖住，但正文若也不写，收件人除了点按没有任何文字依据，
                  //    转发/锁屏预览/无障碍朗读都读不到选项内容。编号同时供
                  //    `select <令牌> N` 数字回复使用。
                  if (options.length > 0) {
                    // 每个选项下带出它的说明（description，截断到可读长度），
                    // 让收件人光看通知就知道每个选项是什么，不必回电脑。
                    // ⚠️ 编号不带「#」也不带「.」：回复语法是 `select <令牌> N`，
                    //    正文若写成 `#1`，用户很可能照抄敲 `select <令牌> #1`，
                    //    而 parser 的 /^\d+$/ 不匹配 `#1` → 被当自由回答提交并消费令牌（静默错答）。
                    //    行首是 `**` 而非数字/列表符，渲染器不会把它当列表，粗体照常生效。
                    //    数字与数组下标对应关系不变，`select <令牌> N` 依旧按下标选第 N 项。
                    //    选项行整体加粗（**…**），ntfy markdown 渲染后突出选项，与 ↳ 说明行形成层级。
                    const descLimit = 80
                    const labelLimit = 30
                    const block = options.map((label, i) => {
                      const desc = optionDescs[i]?.trim() ?? ""
                      // ⚠️ 说明行用「↳」字符前缀表达从属关系——ntfy 渲染器会吃掉行首空格
                      //    （实测缩进丢失），字符前缀才保得住层级；`↳` 前的两个空格仅是额外排版。
                      // ⚠️ label 只在这里截断（仅用于正文展示），options[] 里的原值不动。
                      const line = `**${i + 1} ${clampDisplay(label, labelLimit)}**`
                      return desc ? `${line}\n  ↳ ${clampDisplay(desc, descLimit)}` : line
                    }).join("\n")
                    msg.body += "\n**选项：**\n" + block
                  }
                  msg.body += `\n**令牌：** ${item.code}`
                  msg.replyHint = options.length > 0
                    ? `**回复:** select <令牌> 1~${options.length}=选选项 · select <令牌> 文字=自由回答`
                    : "**回复:** select <令牌> 文字=自由回答"
                }
                // 每条提问都是独立请求：去重 key 含 formID，避免同会话连续提问被吞
                msg.dedupeKey = `opencode:form:${reqID}`
                // 用 form 真实会话判定子会话（data.sessionID 缺失，不能复用上面的 sessionID）
                return await finishNotification(msg, formSessionID)
              }
            } else if (type === "permission.asked") {
              const reqID = String(data.id ?? "")
              if (reqID) {
                const item = control.registerPending(
                  "permission", reqID, sessionID, String(data.action ?? "权限请求"),
                  // 位置（路由依据）：permission.asked 的 location 在**事件顶层**，
                  // data 里只有 id/sessionID/action/resources（实测确认）。
                  // 应答时据此把请求路由到该 location 的实例（宿主按实例 location 门控）。
                  undefined,
                  { locationDirectory: event.location?.directory },
                )
                if (item.code) {
                  msg.controlButtons = control.buildButtons(item)
                  msg.body += `\n**令牌：** ${item.code}`
                  msg.replyHint = "**回复:** approve/deny/always <令牌>"
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
              msg.replyHint = "**回复:** say <令牌> 文本=继续 · stop <令牌>=中断 · status <令牌>=状态"
            }
          }

          debug(`→ 匹配通知: ${msg.event} topic="${sessionTopic ?? ""}" prompt="${(userPrompt ?? "").slice(0, 80)}"`)

          await finishNotification(msg, sessionID)
        } catch (e) {
          error(`事件处理异常 type=${type}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 事件订阅。V2 的 ctx.event.subscribe(options?) 返回 AsyncIterable<Event>，
      // options 是 RequestOptions（{ signal, headers, onActivity }），断开时用 signal 退出循环。
      // 订阅是**活动实例独占**的资源：待命实例不订阅，避免 N 份长连接与重复处理。
      let abort: AbortController | null = null
      const startSubscribe = () => {
        if (abort) return
        abort = new AbortController()
        const signal = abort.signal
        void (async () => {
          try {
            for await (const event of ctx.event.subscribe({ signal })) {
              await handleEvent(event)
            }
          } catch (e) {
            // 订阅流中断即视为插件失效，明确暴露而不静默重试
            if (!signal.aborted) {
              error(`事件订阅异常: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        })()
      }
      const stopSubscribe = () => {
        abort?.abort()
        abort = null
      }

      // 上位：跑命令通道 + 订阅事件。
      // 构造即夺权（最新注册者上位）。
      singleton = new ProcessSingleton({
        id: location,
        activate: () => {
          control?.start()
          startSubscribe()
          info(`单例: 本实例已上位 location=${location}`)
        },
        deactivate: () => {
          stopSubscribe()
          control?.stop()
          info(`单例: 本实例已让位 location=${location}`)
        },
      })

      // 表单应答 RPC：**每个实例都注册**（不是只由活动实例注册）。
      // ⚠️ RPC 注册是**按 location 作用域**的：只注册一份时，位于其它目录的 TUI
      //    调 client.rpc(D) 会得到 rpc.unavailable。因此这里放在 activate 之外，
      //    让每个 location 的实例都提供自己那份 RPC。
      //    重复派发由「等待表共享 + 单例保证只有活动实例发起 request」共同避免；
      //    TUI 的 confirm 可能落到任意实例，故等待表放在 globalThis（见 form-reply-bridge.ts）。
      void formReplyBridge.register(ctx).catch((e: unknown) => {
        error(`表单应答 RPC 注册失败 location=${location}: ${e instanceof Error ? e.message : String(e)}`)
      })

      // 清理：释放单例槽位（内含停订阅 + 停命令通道；若自己是 owner 则交给最新实例）
      return () => {
        info(`单例: 插件卸载 location=${location}`)
        formReplyBridge.dispose()
        // 注销实例登记（校验归属，避免误删同 location 新实例的登记）
        unregisterInstance(location, selfCapability)
        singleton.release()
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
