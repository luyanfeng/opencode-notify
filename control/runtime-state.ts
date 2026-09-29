/**
 * 远程控制的**进程级共享状态**
 *
 * ## 为什么需要
 *
 * opencode 2.x **每个 location（项目目录）各加载一份插件实例**，而实例前缀与
 * 待处理注册表原本都是**实例私有**的。后果：每当宿主加载一个新的 location，
 * 单例就把它选为活动实例，先前实例登记的所有令牌立刻作废 —— 手机上待点按的
 * 授权/提问按钮变成死链，且走「无归属令牌」分支被**静默丢弃**（用户完全无感）。
 *
 * 把「实例前缀」与「待处理注册表」提到**进程级**后，同一 server 进程内任一实例
 * 夺权都不改变前缀与注册表，已发出的令牌继续有效。
 *
 * ## 隔离边界
 *
 * 会合点是 `globalThis`，而它是**每进程独立**的 —— 因此「进程级共享」自动满足
 * 「跨 server 进程 / 跨机器隔离」，无需额外机制。（同机可并存多个 server 进程：
 * `serve --port`、`run --standalone`。）
 *
 * ## 写侧约束（重要）
 *
 * **只有活动实例（owner）会写注册表**：`index.ts` 的 `finishNotification` 开头有
 * `if (!singleton.isActive()) return`，而所有 `registerPending` 都在其后。命令通道
 * 也只有 owner 在跑。因此共享注册表不会让"本应隔离的两份控制逻辑"互相干扰。
 * 改这里前请先确认该约束仍成立。
 *
 * ## 配置变更
 *
 * 注册表参数（令牌有效期、容量上限）可能随配置变化。因为会合点在 `globalThis`
 * 里跨热重载存活，若直接复用会让新配置不生效；故用**指纹**（ttl + max）比对：
 * 变化时按新参数重建，并**先快照旧条目再恢复**（不丢已发出的令牌），最后显式裁剪。
 */

import { PendingRegistry } from "./pending.js"
import { newInstanceId } from "./tokens.js"
import { info } from "../log.js"

/** `globalThis` 会合点键（与 `__opencodeNotifyRuntime__` 等同族命名） */
const STATE_KEY = "__opencodeNotifyControlState__"

/** 构建注册表所需的配置子集（只取影响注册表的字段） */
export interface ControlStateConfig {
  /** 令牌有效期（毫秒） */
  tokenTtlMs: number
  /** 待处理条目容量上限 */
  maxPending: number
}

interface ControlState {
  /** 本 server 进程的实例前缀（多进程隔离用） */
  instance: string
  /** 进程级共享的待处理注册表 */
  registry: PendingRegistry
  /** 注册表参数的指纹；变化即重建 */
  fingerprint: string
}

function fingerprintOf(config: ControlStateConfig): string {
  return `${config.tokenTtlMs}:${config.maxPending}`
}

function root(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>
}

/**
 * 取（必要时建立/重建）本进程的控制状态。
 *
 * - 无状态 → 新建（随机实例前缀 + 空注册表）
 * - 指纹未变 → 直接返回既有状态（保持已发出的令牌）
 * - 指纹变化 → 按新参数重建注册表，并迁移既有条目
 */
export function getControlState(config: ControlStateConfig): ControlState {
  const g = root()
  const existing = g[STATE_KEY] as ControlState | undefined
  const fingerprint = fingerprintOf(config)

  if (!existing) {
    const instance = newInstanceId()
    const created: ControlState = {
      instance,
      // 注册表的实例前缀必须与状态前缀一致：令牌由 registry 生成，门卫用状态前缀比对
      registry: new PendingRegistry(config.maxPending, instance, config.tokenTtlMs),
      fingerprint,
    }
    g[STATE_KEY] = created
    info(`控制状态: 已建立 实例=${created.instance} ttl=${config.tokenTtlMs}ms max=${config.maxPending}`)
    return created
  }

  if (existing.fingerprint === fingerprint) return existing

  // 配置变更：按新参数重建，并迁移既有条目（不丢已发出的令牌）
  const carried = existing.registry.snapshot()
  const rebuilt = new PendingRegistry(config.maxPending, existing.instance, config.tokenTtlMs)
  rebuilt.restore(carried)
  const updated: ControlState = {
    instance: existing.instance,
    registry: rebuilt,
    fingerprint,
  }
  g[STATE_KEY] = updated
  info(
    `控制状态: 配置变更（${existing.fingerprint} → ${fingerprint}），`
    + `已迁移 ${carried.length} 条待处理条目`,
  )
  return updated
}

/**
 * 重置进程级状态（**仅供测试**）
 *
 * 冒烟脚本用它隔离用例；生产代码不得调用（会让已发出的令牌失效，正是本模块要修的问题）。
 */
export function __resetControlStateForTest(): void {
  delete root()[STATE_KEY]
}
