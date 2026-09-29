/**
 * 进程级单例协调
 *
 * ## 为什么需要
 *
 * opencode 2.x **每个 location（项目目录）各加载一份插件实例**，而
 * `ctx.event.subscribe` 收到的是「当前连接 server 的公共事件流」（没有 location 维度），
 * 因此同一个事件会被 N 份实例各处理一次 —— 表现为"一次事件发 N 条重复通知"，
 * 同时还多出 N 条 ntfy 长连接、N 套延迟推送任务。这是宿主的设计，不是 bug。
 *
 * ## 为什么不能用模块级变量
 *
 * 实测（探针）：同一 entrypoint 在同一进程内被求值为 **N 份互相独立的模块**
 * （moduleID 各不相同，模块级计数器恒为 1），模块级状态互不共享。
 * `globalThis` 才是进程级共享的（跨 location 单调递增），是唯一可行的会合点。
 * `ctx.storage` 也不行 —— 它是 per-location 隔离的（落盘按 location 分目录）。
 *
 * ## 选举规则：最新注册者上位
 *
 * 宿主在插件文件变化重载时是会调用 cleanup 的（日志里能看到「插件卸载」），
 * 所以「首个注册者上位 + teardown 交接」并非不能用。但它把正确性押在
 * "宿主每次都调用 cleanup"这个前提上：一旦有例外（只加载新实例而不卸载旧实例），
 * 第一个实例就会一直占着 owner，改配置 / 改代码都不生效，新实例只能干等。
 *
 * 因此改为**每个新注册的实例直接夺权**：旧 owner 显式让位（停订阅 + 停命令通道），
 * 新实例上位。owner 身份存在共享 runtime 上，`isActive()` 动态比对，
 * 被让位的旧实例同步得知自己不再是 owner，不再分发通知。两种时序都成立：
 * 宿主调 cleanup 时走 release 交接，不调时新实例照样上位。
 *
 * 让位后的实例完全空闲（不订阅事件、不连命令通道），只留在列表里等待接替；
 * 万一 teardown 真被调用（进程退出 / location 关闭），则把 owner 交给当前最新
 * 注册且仍存活的实例。这两条路径叠加，覆盖了宿主的所有加载/卸载时序。
 *
 * JS 单线程 ⇒ 注册 / 夺权 / 让位全在同一个同步块内完成，不存在竞态。
 *
 * 已知边界：
 * - 单例范围是「一个 server 进程」。跨进程（多个 opencode server 并存）由
 *   `store.ts` 的按键 O_EXCL 原子占位去重，不依赖本模块。
 * - 接替（teardown 真的发生）时，新 owner 是在自己 setup 之后才上位的，
 *   这期间创建的会话不会补发 `session.created`，子会话识别可能不准
 *   （会多发本该静默的子会话通知）。常态下 owner 不会易主，故影响很小。
 * - `slots` 只在 `release()` 时移除。若宿主真的不调 cleanup，被遗弃的实例会
 *   一直滞留在数组里（其闭包持有 tracker / senders 等，单调增长）。实测重载
 *   都会调 cleanup，所以这只是理论边界，没有为它加额外机制。
 * - 若所有实例被卸载且没有新的注册，owner 会短暂为 null（通知静默）。
 *   宿主的 dispose 总伴随一次 load，因此也只是瞬时。
 */

const RUNTIME_KEY = "__opencodeNotifyRuntime__"

export interface SingletonSlot {
  /** 实例标识，仅用于日志（一般是 location 目录） */
  id: string
  /** 上位为活动实例时调用：启动命令通道 + 订阅事件 */
  activate: () => void
  /** 从活动实例退位时调用：停订阅 + 停命令通道 */
  deactivate: () => void
}

interface Runtime {
  /** 全部实例，按注册顺序排列（末尾为最新） */
  slots: SingletonSlot[]
  /** 当前活动实例；null = 无人上位 */
  owner: SingletonSlot | null
}

function getRuntime(): Runtime {
  const g = globalThis as unknown as Record<string, unknown>
  const existing = g[RUNTIME_KEY] as Runtime | undefined
  if (existing) return existing
  const created: Runtime = { slots: [], owner: null }
  g[RUNTIME_KEY] = created
  return created
}

export class ProcessSingleton {
  private readonly slot: SingletonSlot
  private readonly runtime: Runtime
  private released = false

  constructor(slot: SingletonSlot) {
    this.slot = slot
    this.runtime = getRuntime()
    this.runtime.slots.push(slot)
    // 最新注册者直接夺权：不能等旧 owner 自觉退位（它要等宿主调 cleanup 才退）
    const previous = this.runtime.owner
    this.runtime.owner = slot
    if (previous && previous !== slot) previous.deactivate()
    slot.activate()
  }

  /** 本实例当前是否为活动实例（只有它才允许订阅事件 / 发通知 / 跑命令通道） */
  isActive(): boolean {
    return !this.released && this.runtime.owner === this.slot
  }

  /**
   * 释放槽位（teardown 时调用）
   *
   * 若自己是 owner：先退位，再把 owner 交给当前最新注册的实例。
   */
  release(): void {
    if (this.released) return
    this.released = true
    const index = this.runtime.slots.indexOf(this.slot)
    if (index >= 0) this.runtime.slots.splice(index, 1)
    if (this.runtime.owner !== this.slot) return
    this.slot.deactivate()
    this.runtime.owner = null
    const next = this.runtime.slots[this.runtime.slots.length - 1]
    if (!next) return
    this.runtime.owner = next
    next.activate()
  }
}
