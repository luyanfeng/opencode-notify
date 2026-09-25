import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { OpencodeClient as V2Client } from "@opencode-ai/sdk/v2/client"
import type { ReplyConfig, Command, PendingItem, ControlButton, RawCommandMessage } from "./types.js"
import { parseCommand, HELP_TEXT, isItemToken } from "./parser.js"
import { PendingRegistry } from "./pending.js"
import { SessionCodes } from "./sessions.js"
import { GotifyProvider } from "./gotify.js"
import { NtfyPollProvider } from "./ntfy.js"
import { NtfyStreamProvider } from "./ntfy-stream.js"
import { isSelfMessage } from "./ntfy-common.js"
import { newInstanceId, tokenInstance } from "./tokens.js"
import { info, warn, debug } from "../log.js"


/** 回执限流窗口（毫秒）与窗口内上限（防任何原因的回环刷屏） */
const RECEIPT_WINDOW_MS = 10_000
const RECEIPT_BURST = 8

/**
 * 从 opencode 注入的 v1 client 中提取底层 fetch / headers，构造可用的 v2 client。
 *
 * 背景：opencode 注入的 `PluginInput.client` 是 **v1** 客户端（无 permission/question
 * 命名空间，无法用于远程应答）。直跑模式（`opencode` 非 server）下服务运行在同一进程内、
 * 不监听 HTTP 端口，注入 client 内部用的是**内存 fetch**（`Server.Default().app.fetch`）；
 * 若按 `serverUrl` 自建 client 会连到不可用的 `http://localhost:4096` 导致应答失败。
 *
 * v1 client 内部的 `_client.getConfig()` 返回构造时的配置（含 fetch 与 headers），
 * 这里把它们复用到 v2 client 上，保证直跑模式走内存通道、server 模式走认证网络通道。
 *
 * 提取失败时返回 undefined，由调用方回退为按 serverUrl 自建。
 */
function buildV2Client(injected: unknown, serverUrl: string, directory: string): V2Client | undefined {
  const cfg = (injected as { _client?: { getConfig?: () => { fetch?: typeof fetch; headers?: unknown } } } | undefined)
    ?._client
    ?.getConfig?.()
  const fetchImpl = cfg?.fetch
  if (typeof fetchImpl !== "function") return undefined
  // v2 client 内部对 headers 做对象展开（{ ...headers }），Headers 实例展开会丢失条目，
  // 因此这里先归一化为普通对象，避免丢掉 ServerAuth 认证头。
  const headers = normalizeHeaders(cfg?.headers)
  return createOpencodeClient({
    baseUrl: serverUrl,
    directory,
    fetch: fetchImpl,
    ...(headers ? { headers } : {}),
  })
}

/** 将 Headers 实例 / 普通对象统一归一化为 string 记录，便于安全展开传递 */
function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers as Array<[string, string]>)
  if (typeof headers === "object") return headers as Record<string, string>
  return undefined
}

/**
 * 远程控制控制器
 *
 * 职责：
 *   - 依据配置创建 Gotify / ntfy 命令通道并启动轮询
 *   - 解析手机命令并调用 opencode 本地 API 执行
 *       approve/always/deny → permission.reply
 *       answer              → question.reply
 *       say                 → session.prompt（注入用户指令）
 *       stop                → session.abort
 *       status/help         → 回执状态与帮助
 *   - 维护待处理请求注册表（一次性令牌关联与会话码）
 *   - 生成通知按钮定义（ntfy Actions）
 *   - （可选）向通道发布执行回执
 *
 * 全部为出站连接：不监听任何端口。
 *
 * 多进程隔离：令牌带**本进程实例前缀**。其它进程读到不匹配的令牌时静默忽略，
 * 从而保证同一条按钮命令只被拥有该令牌的进程执行一次。
 */
export class ControlController {
  readonly registry: PendingRegistry
  readonly sessionCodes = new SessionCodes()
  private client: V2Client
  private provider?: import("./types.js").CommandProvider
  private readonly instance = newInstanceId()
  private started = false
  /** 近期回执时间戳（限流用） */
  private receiptTimes: number[] = []

  private readonly clientSource: "injected" | "self"

  constructor(
    private readonly config: ReplyConfig,
    serverUrl: string,
    directory: string,
    injectedClient?: unknown,
  ) {
    this.registry = new PendingRegistry(config.maxPending, this.instance, config.tokenTtlMs)
    // opencode 注入的 client 是 v1 客户端（无 permission/question 命名空间），不能直接使用。
    // 但其内部持有构造时的 fetch / headers：直跑模式下是内存 fetch（Server.Default().app.fetch），
    // 认证头为 ServerAuth.headers()。把它们提取出来构造 v2 client，即可在直跑模式下正确应答。
    const v2 = buildV2Client(injectedClient, serverUrl, directory)
    if (v2) {
      this.client = v2
      this.clientSource = "injected"
    } else {
      warn("control: 未能从 opencode 注入的 client 提取 fetch，回退为按 serverUrl 自建（server 模式可用；直跑模式将连不上本地服务）")
      this.client = createOpencodeClient({ baseUrl: serverUrl, directory })
      this.clientSource = "self"
    }
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
    info(`control: 命令通道已启动 provider=${this.config.provider}${transport} 间隔=${this.config.pollIntervalMs}ms 实例=${this.instance} client=${this.clientSource}`)
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
  ): PendingItem {
    return this.registry.add(kind, requestID, sessionID, title, options)
  }

  /** 回复后清理对应待处理条目 */
  resolvePending(requestID: string): void {
    this.registry.removeByRequestID(requestID)
  }

  /** 会话展示码（仅用于在通知里区分"是哪个会话的通知"，不再作为回复凭证） */
  sessionCode(sessionID: string): string | undefined {
    return this.sessionCodes.codeFor(sessionID)
  }

  /** 会话被删除时回收会话码与该会话的续接凭证 */
  forgetSession(sessionID: string): void {
    this.sessionCodes.remove(sessionID)
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
   * - [复制]（copy 动作）：把 `answer <令牌> ` 写入剪贴板，用户粘贴后补写内容发送
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
    // 复制模板给 select（选选项的标准动词）；自由文本回答用选项按钮或手打 answer
    const copy: ControlButton = { label: "复制选择命令", value: `select ${item.code} ` }
    // 合并模式（启用复制按钮）：优先 [复制]（粘贴后补写，无需手打令牌）
    if (this.config.copyButton) {
      // 选项 ≤2：选项按钮 + 复制（≤3 个）
      if (opts.length > 0 && opts.length <= 2) {
        const btns: ControlButton[] = opts.map((label) => ({ label, body: `answer ${item.code} ${label}` }))
        btns.push(copy)
        return btns.slice(0, 3)
      }
      // 选项 0 或 ≥3：仅复制按钮（正文列编号，用户回复数字选选项）
      return [copy]
    }
    // 分离模式（无复制按钮）：保留旧行为——最多 3 个选项按钮
    return opts.slice(0, 3).map((label) => ({ label, body: `answer ${item.code} ${label}` }))
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
      // 语法帮助由通知正文尾的「📱 回复: …」提示行承担。
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
        const reply = cmd.action === "approve" ? "once" : cmd.action === "always" ? "always" : "reject"
        const res = await this.client.permission.reply({ requestID: item.requestID, reply })
        this.registry.removeByCode(item.code) // 一次性：动作完成即销毁
        return `${reply === "reject" ? "已拒绝" : "已允许"} ${item.code}${res.error ? " (服务返回错误)" : ""}`
      }
      case "answer": {
        if (item.kind !== "question") return null
        const answerText = cmd.text.trim()
        if (!answerText) return "缺少回答内容"
        const listRes = await this.client.question.list({})
        const q = (listRes.data ?? []).find((x) => x.id === item.requestID)
        const count = q?.questions?.length ?? 1
        // 答案按问题顺序；首问填文本，其余留空（API 要求数组长度一致）
        const answers = Array.from({ length: count }, (_, i) => (i === 0 ? [answerText] : []))
        const res = await this.client.question.reply({ requestID: item.requestID, answers })
        this.registry.removeByCode(item.code) // 一次性
        return `已回答 ${item.code}${res.error ? " (服务返回错误)" : ""}`
      }
      case "choose": {
        if (item.kind !== "question") return null
        const opts = item.options ?? []
        if (opts.length === 0) return null
        if (!Number.isInteger(cmd.index) || cmd.index < 1 || cmd.index > opts.length) {
          return `选项序号超出范围（该提问共 ${opts.length} 个选项），令牌未消费可重试`
        }
        const chosen = opts[cmd.index - 1]
        const listRes = await this.client.question.list({})
        const q = (listRes.data ?? []).find((x) => x.id === item.requestID)
        const count = q?.questions?.length ?? 1
        const answers = Array.from({ length: count }, (_, i) => (i === 0 ? [chosen] : []))
        const res = await this.client.question.reply({ requestID: item.requestID, answers })
        this.registry.removeByCode(item.code) // 一次性
        return `已回答 ${item.code}：${chosen}${res.error ? " (服务返回错误)" : ""}`
      }
      case "say": {
        if (item.kind !== "session") return null
        if (!cmd.text.trim()) return "缺少指令内容"
        await this.client.session.prompt({
          sessionID: item.sessionID,
          parts: [{ type: "text", text: cmd.text }],
        })
        // 续接凭证 TTL 内可复用（不移除），过期由 prune 清理
        return `已向会话 ${item.sessionID.slice(0, 8)}… 追加指令`
      }
      case "stop": {
        if (item.kind !== "session") return null
        await this.client.session.abort({ sessionID: item.sessionID })
        return `已中断会话 ${item.sessionID.slice(0, 8)}…`
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
