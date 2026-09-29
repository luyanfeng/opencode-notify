#!/usr/bin/env bun
/**
 * 授权应答路由的**决策逻辑**冒烟：不依赖网络/opencode
 *
 * 覆盖无法稳定构造的真实分支：
 *   1. 目标实例不存在 → PermissionTargetNotOpenError（"项目未打开"语义）
 *   2. 宿主报 not found → 转成 PermissionAlreadySettledError（"已被处理或已取消"）
 *   3. 其它错误原样抛出（不被误判）
 *   4. 路由确实打到「目标 location」的实例（不串台）
 *   5. 两种错误类型的措辞符合 spec 的"失败原因分化"
 *
 * 说明：这里复刻 index.ts 中 bridge.replyPermission 的**决策链**（解析 location →
 * 查注册表 → 调用 → 错误归类），并断言其可观测结果。真实端到端另由 change 的
 * 任务 4.2 验证（owner ≠ 会话 location 时成功）。
 *
 * 运行：bun scripts/permission-routing-smoke.ts
 */

import {
  registerInstance, __resetInstanceRegistryForTest, getInstanceByLocation,
} from "../control/instance-registry.js"
import type { InstanceCapability } from "../control/instance-registry.js"
import { PermissionTargetNotOpenError, PermissionAlreadySettledError } from "../control/types.js"
import { configureLog } from "../log.js"

configureLog("off")

let pass = 0, fail = 0
function check(n: string, c: boolean, d = ""): void {
  if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${d}`) }
}

/** 复刻 index.ts 的 bridge.replyPermission 决策链（仅取决策部分，不依赖 ctx） */
async function routeReplyPermission(
  input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject"; locationDirectory?: string },
  resolveLocation: (sessionID: string, hint?: string) => Promise<string | undefined>,
): Promise<void> {
  const target = await resolveLocation(input.sessionID, input.locationDirectory)
  if (!target) throw new Error("无法确定该会话所属的项目位置，请稍后重试")
  const cap = getInstanceByLocation(target)
  if (!cap) throw new PermissionTargetNotOpenError(target)
  try {
    await cap.replyPermission({
      sessionID: input.sessionID, requestID: input.requestID, decision: input.decision,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    if (/not\s*found|not\s*exist/i.test(msg)) throw new PermissionAlreadySettledError(msg)
    throw e
  }
}

const LOC_TARGET = "/proj/target"
const LOC_OTHER = "/proj/other"

console.log("▶ 1. 目标实例不存在 → PermissionTargetNotOpenError")
{
  __resetInstanceRegistryForTest()
  registerInstance(LOC_OTHER, { replyPermission: async () => {} }) // 只登记别的目录
  let err: unknown
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once", locationDirectory: LOC_TARGET },
    async (_s, hint) => hint,
  ).catch((e) => { err = e })
  check("抛出专用错误类型", err instanceof PermissionTargetNotOpenError, String(err))
  check("错误携带目标 location", (err as PermissionTargetNotOpenError)?.targetLocation === LOC_TARGET)
  check("措辞含「未打开」", /未打开/.test((err as Error)?.message ?? ""), (err as Error)?.message)
  check("措辞含「请先打开该项目」", /请先打开该项目/.test((err as Error)?.message ?? ""))
}

console.log("\n▶ 2. 宿主报 not found → PermissionAlreadySettledError")
{
  __resetInstanceRegistryForTest()
  registerInstance(LOC_TARGET, {
    replyPermission: async () => { throw new Error("Permission request not found: per_1") },
  })
  let err: unknown
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once", locationDirectory: LOC_TARGET },
    async (_s, hint) => hint,
  ).catch((e) => { err = e })
  check("转成「已结算」错误类型", err instanceof PermissionAlreadySettledError, String(err))
  check("措辞含「已被处理或已取消」", /已被处理或已取消/.test((err as Error)?.message ?? ""), (err as Error)?.message)
  check("不再泄漏原始的 'request not found' 措辞到用户可见层（含在括号细节里可接受）",
    !/^Permission request not found/.test((err as Error)?.message ?? ""))
}

console.log("\n▶ 3. 其它错误原样抛出（不被误判为已结算）")
{
  __resetInstanceRegistryForTest()
  registerInstance(LOC_TARGET, {
    replyPermission: async () => { throw new Error("network timeout") },
  })
  let err: unknown
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once", locationDirectory: LOC_TARGET },
    async (_s, hint) => hint,
  ).catch((e) => { err = e })
  check("既不是 TargetNotOpen 也不是 AlreadySettled", !(err instanceof PermissionTargetNotOpenError) && !(err instanceof PermissionAlreadySettledError))
  check("原始信息保留", (err as Error)?.message === "network timeout", (err as Error)?.message)
}

console.log("\n▶ 4. 路由打到「目标 location」的实例（不串台）")
{
  __resetInstanceRegistryForTest()
  const hits: string[] = []
  registerInstance(LOC_TARGET, { replyPermission: async (i) => { hits.push(`target:${i.requestID}`) } })
  registerInstance(LOC_OTHER, { replyPermission: async (i) => { hits.push(`other:${i.requestID}`) } })
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_x", decision: "always", locationDirectory: LOC_TARGET },
    async (_s, hint) => hint,
  )
  check("只打到 target，未打到 other", hits.length === 1 && hits[0] === "target:per_x", JSON.stringify(hits))
}

console.log("\n▶ 5. location 缺失时走查询兜底")
{
  __resetInstanceRegistryForTest()
  registerInstance(LOC_TARGET, { replyPermission: async () => {} })
  let queried = false
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once" }, // 无 hint
    async () => { queried = true; return LOC_TARGET },
  )
  check("hint 缺失时确实查询了会话", queried)
}

console.log("\n▶ 6. hint 存在时不查询（省一次调用）")
{
  __resetInstanceRegistryForTest()
  registerInstance(LOC_TARGET, { replyPermission: async () => {} })
  let queried = false
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once", locationDirectory: LOC_TARGET },
    // 复刻真实 resolveSessionLocation 的契约：有 hint 直接返回 hint（不查会话）
    async (_s, hint) => {
      if (hint) return hint
      queried = true
      return LOC_OTHER
    },
  )
  check("有 hint 时不查询（以 hint 为准）", queried === false)
  check("且以 hint 路由成功（未落到未登记的 other）", true)
}

console.log("\n▶ 7. 查询也拿不到 location → 明确报错")
{
  __resetInstanceRegistryForTest()
  let err: unknown
  await routeReplyPermission(
    { sessionID: "ses_1", requestID: "per_1", decision: "once" },
    async () => undefined,
  ).catch((e) => { err = e })
  check("抛出错误而非静默", err instanceof Error, String(err))
  check("措辞含「无法确定」", /无法确定/.test((err as Error)?.message ?? ""), (err as Error)?.message)
}

__resetInstanceRegistryForTest()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
