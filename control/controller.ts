import type { ReplyConfig, Command, PendingItem, ControlButton, RawCommandMessage, OpencodeBridge } from "./types.js"
import { parseCommand, HELP_TEXT, isItemToken } from "./parser.js"
import { PendingRegistry } from "./pending.js"
import { GotifyProvider } from "./gotify.js"
import { NtfyPollProvider } from "./ntfy.js"
import { NtfyStreamProvider } from "./ntfy-stream.js"
import { isSelfMessage } from "./ntfy-common.js"
import { tokenInstance } from "./tokens.js"
import { getControlState } from "./runtime-state.js"
import { info, warn, debug } from "../log.js"


/** 回执限流窗口（毫秒）与窗口内上限（防任何原因的回环刷屏） */
const RECEIPT_WINDOW_MS = 10_000
const RECEIPT_BURST = 8

/**
 * 远程控制控制器
 *
 * 职责：
 *   - 依据配置创建 Gotify / ntfy 命令通道并启动轮询
 *   - 解析手机命令并经 `bridge` 调用 opencode 宿主能力执行
 *       approve/always/deny → permission.reply
 *       answer/select        → session.form.reply（V2 取代 V1 的 question.reply）
 *       say                  → session.prompt（注入用户指令）
 *       stop                 → session.interrupt（V2 由 abort 改名）
 *       status/help          → 回执状态与帮助
 *   - 维护待处理请求注册表（一次性令牌关联）
 *   - 生成通知按钮定义（ntfy Actions）
 *   - （可选）向通道发布执行回执
 *
 * 全部为出站连接：不监听任何端口。
 *
 * 宿主能力经 `OpencodeBridge` 窄接口注入（V1 时代是"从注入 client 提取 fetch/headers
 * 自建 SDK client"，V2 插件 ctx 直接给 `ctx.permission` / `ctx.session` 域，无需自建）。
 *
 * 多进程隔离：令牌带**本进程实例前缀**。其它进程读到不匹配的令牌时静默忽略，
 * 从而保证同一条按钮命令只被拥有该令牌的进程执行一次。
 */
export class ControlController {
  readonly registry: PendingRegistry
  private readonly bridge: OpencodeBridge
  /**
   * 实例前缀与待处理注册表都取自**进程级共享状态**（见 `runtime-state.ts`）。
   *
   * 为什么不放在实例上：宿主每个 location 各加载一份实例，而单例只在其中选一个
   * owner —— 若前缀/注册表是实例私有的，owner 一变，先前实例发出的令牌就全部作废
   * （手机端静默无响应）。
   */
  private readonly instance: string
  private provider?: import("./types.js").CommandProvider
  private started = false
  /** 近期回执时间戳（限流用） */
  private receiptTimes: number[] = []

  constructor(
    private readonly config: ReplyConfig,
    bridge: OpencodeBridge,
  ) {
    const state = getControlState({ tokenTtlMs: config.tokenTtlMs, maxPending: config.maxPending })
    this.instance = state.instance
    this.registry = state.registry
    this.bridge = bridge
  }

  start(): void {
    if (this.started || !this.config.enabled) return
    this.started = true
    this.provider = this.createProvider()
    if (!this.provider) {
      warn(`control: 配置不完整，命令通道未启动 (provider=${this.config.provider})`)
      return
    }
    this.provider.start(this.config.pollIntervalMs, (m) => void this.onRawMessage(m))
    const transport = this.config.provider === "ntfy" ? ` transport=${this.config.transport ?? "stream"}${this.config.merged ? " merged" : ""}` : ""
    info(`control: 命令通道已启动 provider=${this.config.provider}${transport} 间隔=${this.config.pollIntervalMs}ms 实例=${this.instance}`)
  }

  stop(): void {
    this.provider?.stop()
    this.provider = undefined
    this.started = false
  }

  /** 注册待处理条目，返回带一次性令牌的条目（用于在通知里展示与生成按钮） */
  registerPending(
    kind: PendingItem["kind"],
    requestID: string,
    sessionID: string,
    title: string,
    options?: string[],
    formExtra?: Pick<PendingItem, "answerKey" | "optionValues" | "locationDirectory">,
  ): PendingItem {
    return this.registry.add(kind, requestID, sessionID, title, options, formExtra)
  }

  /** 回复后清理对应待处理条目 */
  resolvePending(requestID: string): void {
    this.registry.removeByRequestID(requestID)
  }

  /** 会话被删除时回收该会话的续接凭证 */
  forgetSession(sessionID: string): void {
    this.registry.removeByRequestID(`session:${sessionID}`)
  }

  /**
   * 注册"续接会话"凭证（run_completed/failed/cancelled 通知时调用）。
   * 返回一次性令牌形态的 session 型条目码（TTL 内可反复用于 say/stop）。
   */
  registerSessionCredential(sessionID: string): string | undefined {
    return this.registry.add("session", `session:${sessionID}`, sessionID, "续接会话").code || undefined
  }

  /**
   * 生成通知按钮（供 ntfy Actions 渲染；服务端硬限每条 ≤3 个）。
   * - 权限：允许 /（始终允许）/ 拒绝（http，点按即执行）
   * - 提问：选项 ≤2 → 选项按钮 + [复制]；选项 0 或 ≥3 → 仅 [复制]（正文编号，靠数字回复）
   * - [复制]（copy 动作）：把 `select <令牌> ` 写入剪贴板，用户粘贴后补写序号或文字均可
   */
  buildButtons(item: PendingItem): ControlButton[] {
    if (!item.code) return []
    if (item.kind === "permission") {
      const btns: ControlButton[] = [
        { label: "允许", body: `approve ${item.code}` },
      ]
      if (this.config.buttonAlways) {
        btns.push({ label: "始终允许", body: `always ${item.code}` })
      }
      btns.push({ label: "拒绝", body: `deny ${item.code}` })
      return btns.slice(0, 3)
    }

    const opts = item.options ?? []
    // 按钮点按提交的必须是 form 的**回传值**（option.value），显示用 label。
    // 两者相同时行为与旧 question 一致；不同时必须用 value，否则宿主匹配不到选项。
    const valueOf = (i: number): string => item.optionValues?.[i] ?? opts[i]
    // 复制模板给 select：`select <令牌> <数字>` 选第 n 项，`select <令牌> <文字>` 自由回答，
    // 粘贴后补序号或直接写字都能用；选项按钮走的才是 answer（直接提交某个回传值）。
    const copy: ControlButton = { label: "复制选择命令", value: `select ${item.code} ` }
    // 合并模式（启用复制按钮）：优先 [复制]（粘贴后补写，无需手打令牌）
    if (this.config.copyButton) {
      // 选项 ≤2：选项按钮 + 复制（≤3 个）
      if (opts.length > 0 && opts.length <= 2) {
        const btns: ControlButton[] = opts.map((label, i) => ({ label, body: `answer ${item.code} ${valueOf(i)}` }))
        btns.push(copy)
        return btns.slice(0, 3)
      }
      // 选项 0 或 ≥3：仅复制按钮（正文列编号，用户回复数字选选项）
      return [copy]
    }
    // 分离模式（无复制按钮）：保留旧行为——最多 3 个选项按钮
    return opts.slice(0, 3).map((label, i) => ({ label, body: `answer ${item.code} ${valueOf(i)}` }))
  }

  /**
   * 生成"续接命令"复制按钮（run_completed/failed/cancelled 用）。
   * value = `say <续接令牌> `（带尾空格），用户粘贴后补写指令发送。
   * 凭证为 session 型：TTL 内可反复 say/stop。
   */
  buildSayCopyButton(sessionID: string): ControlButton | undefined {
    if (!this.config.copyButton) return undefined
    const cred = this.registerSessionCredential(sessionID)
    if (!cred) return undefined
    return { label: "复制续接命令", value: `say ${cred} ` }
  }

  /**
   * 「状态」按钮（http，零输入查看待处理列表）。
   * body 必须携带凭证才能被受理（凭证强制协议）；用当前会话的续接凭证（验证不消费）。
   */
  buildStatusButton(sessionID?: string): ControlButton {
    const cred = sessionID ? this.registerSessionCredential(sessionID) : undefined
    return { label: "状态", body: cred ? `status ${cred}` : "status" }
  }

  private createProvider(): import("./types.js").CommandProvider | undefined {
    const c = this.config
    if (c.provider === "gotify") {
      if (!c.clientToken || !c.serverUrl || !c.appId) return undefined
      return new GotifyProvider(c.serverUrl, c.appId, c.clientToken, c.appToken, c.receiptPriority)
    }
    if (c.provider === "ntfy") {
      if (!c.serverUrl || !c.commandTopic) return undefined
      if (c.transport === "poll") {
        return new NtfyPollProvider(c.serverUrl, c.commandTopic, c.notifyTopic, c.ntfyToken, c.receiptPriority, c.botTag)
      }
      return new NtfyStreamProvider(c.serverUrl, c.commandTopic, c.notifyTopic, c.ntfyToken, c.receiptPriority, { botTag: c.botTag })
    }
    return undefined
  }

  private async onRawMessage(m: RawCommandMessage): Promise<void> {
    // 第三道防线（provider 已过滤，此处再兜底）：插件自身消息绝不解析为命令，
    // 否则回执 → 未识别提示 → 再回执 → 自激。tag 标记 + 回执标题双重识别。
    if (isSelfMessage(m, this.config.botTag)) {
      debug(`control: 忽略自身消息 id=${m.id}`)
      return
    }

    const parsed = parseCommand(m.message, m.title, this.config.secret)
    if (!parsed.ok) {
      // 凭证强制协议：无令牌/语法不合规 → **完全静默**（不发回执，防止刷屏与回环）。
      // 语法帮助由通知正文尾的「回复: …」提示行承担。
      info(`control: 忽略无凭证/未识别消息 id=${m.id} 原因=${parsed.reason}`)
      return
    }
    const cmd = parsed.command
    const token = this.findToken(cmd)
    // 凭证门卫：令牌必须存在（parser 保证）且属于本实例——多实例/多机共用话题时，
    // 别的实例的令牌在本实例是"查无此证"，静默忽略（对方会受理）。
    if (!token || tokenInstance(token) !== this.instance) {
      info(`control: 忽略无归属令牌消息 id=${m.id} token=${token ?? "(无)"} 本实例=${this.instance}`)
      return
    }
    // 验证凭证（不消费）：查无此证（已用完/过期/不存在）→ 静默
    const owned = this.registry.getByCode(token)
    if (!owned) {
      info(`control: 忽略无效令牌消息 id=${m.id} token=${token}（已消费/过期/不存在）`)
      return
    }
    info(`control: 收到命令 id=${m.id} action=${cmd.action} token=${token}`)
    let receipt: string | null
    try {
      receipt = await this.execute(cmd, owned)
    } catch (e) {
      receipt = `执行失败: ${e instanceof Error ? e.message : String(e)}`
      warn(`control: ${receipt}`)
    }
    // null = 凭证与动作不符等静默场景（不给错误实例/错误目标发回执）
    if (receipt === null) {
      info(`control: 静默忽略（令牌与动作类型不符） id=${m.id} action=${cmd.action} kind=${owned.kind}`)
      return
    }
    await this.reply(receipt, cmd.action)
  }

  /**
   * 发布回执（未配置回执通道时仅记日志）。
   *
   * 内置**限流**：任何原因（配置错误、未知回环）导致的自激，都不可能在短时间内刷屏——
   * 10s 窗口内最多发 RECEIPT_BURST 条，超出则丢弃并告警（仍写日志便于定位根因）。
   */
  private async reply(text: string, action?: Command["action"]): Promise<void> {
    if (!this.config.receipt || !this.provider?.publishReceipt) {
      info(`control: 回执(未发送) ${text}`)
      return
    }
    const now = Date.now()
    this.receiptTimes = this.receiptTimes.filter((t) => now - t < RECEIPT_WINDOW_MS)
    if (this.receiptTimes.length >= RECEIPT_BURST) {
      warn(`control: 回执触发限流（${RECEIPT_WINDOW_MS / 1000}s 内已发 ${this.receiptTimes.length} 条），本条第丢弃以防刷屏；请检查是否有回环`)
      return
    }
    this.receiptTimes.push(now)
    await this.provider.publishReceipt(text)
    info(`control: 已处理命令${action ? ` action=${action}` : ""} 并回执: ${text.slice(0, 120)}`)
  }

  /** 从命令中提取令牌（ref 或 answer 文本中的令牌） */
  private findToken(cmd: Command): string | undefined {
    if ("ref" in cmd && cmd.ref && isItemToken(cmd.ref)) return cmd.ref
    if (cmd.action === "answer" && isItemToken(cmd.text.split(/\s+/)[0] ?? "")) {
      return cmd.text.split(/\s+/)[0]
    }
    return undefined
  }

  /**
   * 调用宿主能力并把失败归一为错误文本。
   *
   * V2 的 ctx 域方法失败会 reject（不像 V1 SDK 那样返回 `{ error }`），
   * 这里统一 catch → 返回错误描述，由调用方拼进回执文案；
   * 同时 warn 落日志，保证出错可被发现而不是被静默吞掉。
   *
   * @returns 成功返回 undefined；失败返回错误描述
   */
  private async callBridge(fn: () => Promise<void>): Promise<string | undefined> {
    try {
      await fn()
      return undefined
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warn(`control: 宿主能力调用失败: ${msg}`)
      return msg
    }
  }

  /**
   * 执行命令（凭证强制协议）。
   *
   * 入口已由 onRawMessage 完成**凭证门卫**：`item` 即令牌对应的本实例条目。
   * 所有失败路径返回说明文本——但**是否回执由调用方决定**：kind 不匹配等
   * "凭证与动作不符"的情况应静默（返回 null），避免给错误实例/错误目标发回执。
   * 返回 null = 静默；字符串 = 回执文本。
   */
  private async execute(cmd: Command, item: PendingItem): Promise<string | null> {
    switch (cmd.action) {
      case "approve":
      case "always":
      case "deny": {
        if (item.kind !== "permission") return null // 凭证与动作不符 → 静默
        const decision = cmd.action === "approve" ? "once" : cmd.action === "always" ? "always" : "reject"
        const err = await this.callBridge(
          () => this.bridge.replyPermission({
            sessionID: item.sessionID,
            requestID: item.requestID,
            decision,
            locationDirectory: item.locationDirectory,
          }),
        )
        const prefix = decision === "reject" ? "已拒绝" : "已允许"
        // 失败不消费令牌：动作没有生效，令牌留着（TTL 内可重试）
        if (err) return `${prefix} ${item.code} 失败（令牌未消费）：${err}`
        this.registry.removeByCode(item.code) // 一次性：动作完成即销毁
        return `${prefix} ${item.code}`
      }
      case "answer": {
        if (item.kind !== "form") return null
        const answerText = cmd.text.trim()
        if (!answerText) return "缺少回答内容"
        const err = await this.callBridge(
          () => this.bridge.replyForm({
            sessionID: item.sessionID,
            formID: item.requestID,
            answer: { [item.answerKey ?? "q0"]: answerText },
            locationDirectory: item.locationDirectory,
          }),
        )
        // 失败不消费令牌：动作没有生效，令牌留着（TTL 内可重试）
        if (err) return `应答失败 ${item.code}（令牌未消费）：${err}`
        this.registry.removeByCode(item.code) // 一次性
        return `已回答 ${item.code}`
      }
      case "choose": {
        if (item.kind !== "form") return null
        const opts = item.options ?? []
        if (opts.length === 0) return null
        if (!Number.isInteger(cmd.index) || cmd.index < 1 || cmd.index > opts.length) {
          return `选项序号超出范围（该提问共 ${opts.length} 个选项），令牌未消费可重试`
        }
        const chosen = opts[cmd.index - 1]
        // 显示文本（options[i]）与回传值（optionValues[i]）可能不同，回传必须用后者
        const chosenValue = item.optionValues?.[cmd.index - 1]
        if (chosenValue === undefined) {
          warn(`control: form ${item.requestID} 的选项 ${cmd.index} 缺少回传值，无法应答（令牌未消费）`)
          return `选项 ${cmd.index} 缺少回传值，无法应答，令牌未消费可重试`
        }
        const err = await this.callBridge(
          () => this.bridge.replyForm({
            sessionID: item.sessionID,
            formID: item.requestID,
            answer: { [item.answerKey ?? "q0"]: chosenValue },
            locationDirectory: item.locationDirectory,
          }),
        )
        // 失败不消费令牌（同 answer 分支）
        if (err) return `应答失败 ${item.code}：${chosen}（令牌未消费）：${err}`
        this.registry.removeByCode(item.code) // 一次性
        return `已回答 ${item.code}：${chosen}`
      }
      case "say": {
        if (item.kind !== "session") return null
        if (!cmd.text.trim()) return "缺少指令内容"
        const err = await this.callBridge(
          () => this.bridge.prompt({ sessionID: item.sessionID, text: cmd.text }),
        )
        // 续接凭证 TTL 内可复用（不移除），过期由 prune 清理
        return err
          ? `向会话 ${item.sessionID.slice(0, 8)}… 追加指令失败: ${err}`
          : `已向会话 ${item.sessionID.slice(0, 8)}… 追加指令`
      }
      case "stop": {
        if (item.kind !== "session") return null
        const err = await this.callBridge(
          () => this.bridge.interrupt({ sessionID: item.sessionID }),
        )
        return err
          ? `中断会话 ${item.sessionID.slice(0, 8)}… 失败: ${err}`
          : `已中断会话 ${item.sessionID.slice(0, 8)}…`
      }
      case "status": {
        // 只读查询：验证不消费（门卫已验证归属）。session 型也不消费。
        const list = this.registry.list()
        const lines = [
          `待处理 ${list.length} 条:`,
          ...list.map((i) => `  [${i.kind}] ${i.title} (${i.code})`),
        ]
        return lines.join("\n")
      }
      case "help":
        return HELP_TEXT
    }
  }


}
