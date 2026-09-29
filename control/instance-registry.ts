/**
 * 进程级「插件实例注册表」
 *
 * ## 为什么需要
 *
 * 宿主对 `permission.reply` 有**按调用实例 location 的门控**：只有实例的 location
 * 等于会话所属目录时，宿主才认这个请求，否则报 `Permission request not found`（实测：
 * 7 个实例同时尝试同一请求，仅 location 匹配者成功）。而插件是「每 location 一份实例、
 * 单例只选一个 owner」，owner 可能属于任意目录 —— 于是授权应答时灵时不灵。
 *
 * 修法：让**会话所属 location 的那个实例**去应答。同进程内实例无法互相引用，
 * 因此用一个进程级注册表把它们登记起来，owner 按 location 查出目标实例并直接调用。
 *
 * ## ⚠️ 只暴露最小接口
 *
 * 登记的是**受限能力对象**（当前只有 `replyPermission`），**不是**整个插件 ctx。
 * 暴露完整 ctx 会让任意实例能对任意 location 调用全部宿主能力，破坏 location 隔离语义。
 * 新增能力前先想清楚：它是否受 location 门控、是否应该被跨实例调用。
 *
 * ## 隔离边界
 *
 * 会合点是 `globalThis`，**每进程独立**，因此跨 server 进程/跨机器自然隔离
 * （与 `process-singleton` / `runtime-state.ts` / `form-reply-bridge` 同族）。
 *
 * ## 覆盖语义
 *
 * 以 location 为键：**后登记覆盖前者**（热重载时新实例覆盖旧实例的登记），
 * 避免同名 location 残留两个条目。`unregister` 校验归属，避免旧实例卸载时
 * 误删新实例的登记。
 */

/** 面向其它实例暴露的**最小**能力（勿扩展为完整 ctx） */
export interface InstanceCapability {
  /**
   * 以**本实例**的名义应答权限请求
   *
   * 注意：调用方应确保目标会话属于本实例的 location，否则宿主会拒绝。
   */
  replyPermission(input: {
    sessionID: string
    requestID: string
    decision: "once" | "always" | "reject"
  }): Promise<void>
}

interface Entry {
  location: string
  capability: InstanceCapability
}

const REGISTRY_KEY = "__opencodeNotifyInstances__"

function root(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>
}

/** 取（必要时建立）进程级注册表 */
function getMap(): Map<string, Entry> {
  const g = root()
  const existing = g[REGISTRY_KEY] as Map<string, Entry> | undefined
  if (existing) return existing
  const created = new Map<string, Entry>()
  g[REGISTRY_KEY] = created
  return created
}

/**
 * 登记本实例
 *
 * 以 location 为键，**后登记覆盖前者**（热重载时新实例接管该 location）。
 */
export function registerInstance(location: string, capability: InstanceCapability): void {
  getMap().set(location, { location, capability })
}

/**
 * 注销本实例
 *
 * 仅当当前登记**仍是本实例的能力对象**时才移除，避免旧实例卸载时误删
 * 新实例（同 location 重载后）的登记。
 */
export function unregisterInstance(location: string, capability: InstanceCapability): void {
  const map = getMap()
  const cur = map.get(location)
  if (cur && cur.capability === capability) map.delete(location)
}

/** 按 location 查目标实例能力；未登记返回 undefined */
export function getInstanceByLocation(location: string): InstanceCapability | undefined {
  return getMap().get(location)?.capability
}

/** 当前已登记的 location 列表（诊断用） */
export function listInstanceLocations(): string[] {
  return [...getMap().keys()]
}

/** 清空注册表（**仅供测试**） */
export function __resetInstanceRegistryForTest(): void {
  getMap().clear()
}
