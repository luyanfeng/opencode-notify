/**
 * 服务端侧的「表单应答桥」
 *
 * ## 职责
 *
 * 服务端无法直接调 `session.form.reply`（ctx 无 form 域），因此把应答请求经 RPC 事件
 * 派发给 TUI 入口，并**等待 TUI 回调确认**后才判定成败：
 *
 * ```
 * replyForm()  ──► emit("request")  ──►  TUI 执行 form.reply
 *      ▲                                        │
 *      └──── 确认成功 / 失败 / 超时 ◄── methods.confirm
 * ```
 *
 * ## 为什么必须等确认（而不是发完就算）
 *
 * RPC 事件是**即发即忘**，且订阅是**实时连接**（断开期间的订阅事件会丢失）。
 * 不等确认就无法区分「没有 TUI 在处理」与「已处理」，也就无法满足需求
 * 「无可用终端客户端时如实告知」与「仅成功后消费令牌」。
 *
 * ## 为什么每个实例都要注册 RPC（而等待表要共享）
 *
 * ⚠️ **RPC 注册是按 location 作用域的**（实测：只由一个实例注册时，位于其它目录的
 * TUI 调 `client.rpc(D)` 会得到 `rpc.unavailable`）。本插件在一个 server 进程里
 * 会按 location 加载多份实例，因此**每个实例都必须注册自己那份**，否则只有
 * "恰好夺权那个 location"能应答。
 *
 * 但 `request()` 只由**活动实例**发起，而 TUI 的 `confirm` 会打到**它自己所在
 * location 的那个实例** —— 可能是任意一个。所以等待表不能是实例私有的，必须放在
 * 进程级共享的 `globalThis` 上，任一实例的 `confirm` 才能唤醒发起者的等待者。
 * （会合点与 `process-singleton.ts` 同理：模块级状态在同一 entrypoint 被求值成
 *  多份时并不共享，`globalThis` 才是进程级共享的。）
 */

import { FormReplyRpc } from "./form-reply-rpc.js"
import type { FormReplyRequest } from "./form-reply-rpc.js"
import { info, warn } from "./log.js"

/** 应答等待默认上限（毫秒）。超过即判定「无可用终端客户端」。 */
export const DEFAULT_FORM_REPLY_TIMEOUT_MS = 5000

/** RPC 注册句柄的最小结构视图（避免依赖 opencode 的内部类型路径） */
export interface RpcRegistrationHandle {
  dispose(): Promise<void>
  readonly events: {
    emit(name: "request", payload: FormReplyRequest): Promise<void>
  }
}

/** 供 RPC 注册用的最小 ctx 视图（避免耦合完整的 opencode Context 类型） */
export interface FormReplyRpcHost {
  rpc: {
    register: (
      definition: typeof FormReplyRpc,
      handlers: {
        confirm: (input: unknown) => Promise<{ ok: boolean }>
        ping: () => Promise<{ ok: boolean }>
      },
    ) => Promise<RpcRegistrationHandle>
  }
}

interface Waiter {
  promise: Promise<void>
  settle: (ok: boolean, failureKind?: string) => void
  /** 清理定时器并移除登记，但**不**结算 promise（供调用方将自行抛错时避免 unhandledRejection） */
  cancel: () => void
  /** 发起该等待的桥实例 id（dispose 时只回收自己发起的等待） */
  ownerId: string
}

/** 超时（无 TUI 处理）时抛出的错误 —— 上层据此回执「请回电脑处理」 */
export class FormReplyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`当前没有终端客户端在运行（等待应答确认超过 ${Math.round(timeoutMs / 1000)} 秒），请回电脑处理`)
    this.name = "FormReplyTimeoutError"
  }
}

/** TUI 报告投递失败时抛出的错误 —— 携带失败类别与原因 */
export class FormReplyFailedError extends Error {
  readonly failureKind: string
  constructor(failureKind: string, reason: string) {
    super(reason)
    this.name = "FormReplyFailedError"
    this.failureKind = failureKind
  }
}

// ── 进程级共享的等待表（见文件头「为什么等待表要共享」）─────────────────────

const WAITERS_KEY = "__opencodeNotifyFormReplyWaiters__"

type SharedWaiters = Map<string, Waiter>

function getSharedWaiters(): SharedWaiters {
  const g = globalThis as unknown as Record<string, unknown>
  const existing = g[WAITERS_KEY] as SharedWaiters | undefined
  if (existing) return existing
  const created: SharedWaiters = new Map()
  g[WAITERS_KEY] = created
  return created
}

let instanceSeq = 0

/**
 * 表单应答桥（服务端侧）
 *
 * 一次 `request()` 的生命周期：
 * 1. 校验入参；
 * 2. 若同 `formID` 已在等待，复用既有等待（不重复派发）；
 * 3. 登记等待者 → `emit("request")`；
 * 4. 收到 `confirm` → resolve / reject；超时 → 以 `FormReplyTimeoutError` 拒绝。
 */
export class FormReplyBridge {
  private readonly timeoutMs: number
  private readonly id = `frb-${++instanceSeq}`
  private registration: RpcRegistrationHandle | undefined

  constructor(timeoutMs: number = DEFAULT_FORM_REPLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  /** 本实例当前等待中的应答数（供诊断/测试观察） */
  get pendingCount(): number {
    let n = 0
    for (const w of getSharedWaiters().values()) if (w.ownerId === this.id) n += 1
    return n
  }

  /**
   * 注册 RPC（含 `confirm` / `ping` 处理器）。
   *
   * **每个实例都要调用**（RPC 按 location 作用域，见文件头）。幂等：重复调用只注册一次。
   * `confirm` 委托给进程级共享等待表，因此 TUI 打到任意实例都能唤醒发起者。
   */
  async register(host: FormReplyRpcHost): Promise<void> {
    if (this.registration) return
    this.registration = await host.rpc.register(FormReplyRpc, {
      confirm: async (input) => {
        // JSON Schema 定义的 input 在 TS 侧是 unknown，这里按契约收窄
        const { formID, ok, failureKind } = input as { formID: string; ok: boolean; failureKind?: string }
        this.settle(formID, ok, failureKind)
        return { ok: true }
      },
      ping: async () => ({ ok: true }),
    })
    info(`表单应答桥: RPC 已注册 id=${FormReplyRpc.id} instance=${this.id}`)
  }

  /**
   * 注销 RPC，并让**本实例发起**的等待者立即失败（卸载时调用）。
   * 不动别的实例发起的等待者 —— 它们会照常由共享等待表结算或超时。
   */
  dispose(): void {
    for (const [formID, waiter] of [...getSharedWaiters().entries()]) {
      if (waiter.ownerId !== this.id) continue
      waiter.settle(false, "error")
    }
    const reg = this.registration
    this.registration = undefined
    if (reg) {
      void reg.dispose().catch((e: unknown) => {
        warn(`表单应答桥: RPC 注销失败 ${e instanceof Error ? e.message : String(e)}`)
      })
    }
  }

  /**
   * 派发一次表单应答并等待确认。
   *
   * @throws FormReplyFailedError   TUI 报告投递失败（含已被宿主结算）
   * @throws FormReplyTimeoutError  超时未确认（无可用终端客户端）
   */
  async request(input: FormReplyRequest): Promise<void> {
    const reg = this.registration
    if (!reg) {
      throw new FormReplyFailedError("error", "表单应答通道尚未就绪，请稍后重试")
    }
    if (!input.formID || !input.sessionID || !input.answer) {
      throw new FormReplyFailedError("error", "应答参数不完整（缺少表单/会话/答案）")
    }

    // 同 formID 已在等待：复用既有等待，不重复派发
    const existing = getSharedWaiters().get(input.formID)
    if (existing) {
      info(`表单应答桥: form ${input.formID} 已有等待者，复用而不重复派发`)
      return existing.promise
    }

    const waiter = this.createWaiter(input.formID)
    try {
      await reg.events.emit("request", input)
    } catch (e) {
      // 派发本身失败：清理该等待者（不结算 —— 我们紧接着抛出等价错误），避免悬挂到超时，
      // 也避免 unhandledRejection。
      this.cancelWaiter(input.formID)
      throw new FormReplyFailedError("error", `派发应答请求失败：${e instanceof Error ? e.message : String(e)}`)
    }
    return waiter
  }

  /** 登记等待者；超时即以 FormReplyTimeoutError 结算 */
  private createWaiter(formID: string): Promise<void> {
    // 先建 promise（拿 resolve/reject），再登记，最后挂定时器。
    // ⚠️ 顺序敏感：`settle` 闭包引用 `timer`，必须保证它只在 `timer` 初始化之后被调用
    //    （synchronous 的 settle 调用已被「已登记」前置条件排除）。
    let resolveFn: () => void = () => {}
    let rejectFn: (e: Error) => void = () => {}
    const promise = new Promise<void>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })

    const settle = (ok: boolean, failureKind?: string): void => {
      if (!getSharedWaiters().has(formID)) return
      getSharedWaiters().delete(formID)
      clearTimeout(timer)
      if (ok) {
        resolveFn()
      } else {
        rejectFn(
          new FormReplyFailedError(
            failureKind ?? "error",
            failureKind === "settled"
              ? "该提问已被回答或已取消（宿主已结算）"
              : "终端客户端投递应答失败",
          ),
        )
      }
    }

    const cancel = (): void => {
      if (!getSharedWaiters().has(formID)) return
      getSharedWaiters().delete(formID)
      clearTimeout(timer)
    }

    const timer = setTimeout(() => {
      if (!getSharedWaiters().has(formID)) return
      getSharedWaiters().delete(formID)
      warn(`表单应答桥: form ${formID} 等待确认超时（${this.timeoutMs}ms），判定无可用终端客户端`)
      rejectFn(new FormReplyTimeoutError(this.timeoutMs))
    }, this.timeoutMs)

    getSharedWaiters().set(formID, { promise, settle, cancel, ownerId: this.id })
    return promise
  }

  /** 收到 TUI 确认：兑现等待者（委托共享表，任意实例收到都生效） */
  private settle(formID: string, ok: boolean, failureKind?: string): void {
    const waiter = getSharedWaiters().get(formID)
    if (!waiter) {
      // 超时后迟到的确认，或重复确认：忽略（不是错误）
      info(`表单应答桥: 收到无等待者的确认 form=${formID} ok=${ok}（可能已超时，忽略）`)
      return
    }
    waiter.settle(ok, failureKind)
  }

  /** 仅移除等待者与定时器，不结算其 promise（供调用方自行抛错的路径使用） */
  private cancelWaiter(formID: string): void {
    getSharedWaiters().get(formID)?.cancel()
  }
}
