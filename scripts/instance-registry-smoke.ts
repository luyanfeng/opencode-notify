#!/usr/bin/env bun
/**
 * 实例注册表冒烟：不依赖网络/opencode
 *
 *   1. 登记后可查；未登记返回 undefined
 *   2. 注销后不可查
 *   3. 同名 location 后登记覆盖前者（热重载语义）
 *   4. 旧实例注销**不误删**新登记（归属校验）
 *   5. 多 location 互不干扰
 *   6. list() 反映当前登记
 *
 * 运行：bun scripts/instance-registry-smoke.ts
 */

import {
  registerInstance, unregisterInstance, getInstanceByLocation,
  listInstanceLocations, __resetInstanceRegistryForTest,
} from "../control/instance-registry.js"
import type { InstanceCapability } from "../control/instance-registry.js"
import { configureLog } from "../log.js"

configureLog("off")

let pass = 0, fail = 0
function check(n: string, c: boolean, d = ""): void {
  if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${d}`) }
}

/** 造一个可辨识的能力对象（带 tag 便于断言是哪一个） */
function mkCap(tag: string, record?: string[]): InstanceCapability {
  return {
    replyPermission: async (i) => { record?.push(`${tag}:${i.requestID}`) },
  }
}

const A = "/proj/a"
const B = "/proj/b"

console.log("▶ 1. 登记与查询")
{
  __resetInstanceRegistryForTest()
  const capA = mkCap("A")
  registerInstance(A, capA)
  check("登记后可按 location 查到", getInstanceByLocation(A) === capA)
  check("未登记的 location 返回 undefined", getInstanceByLocation(B) === undefined)
  check("未登记的其它目录也返回 undefined", getInstanceByLocation("/proj/zzz") === undefined)
}

console.log("\n▶ 2. 注销")
{
  __resetInstanceRegistryForTest()
  const capA = mkCap("A")
  registerInstance(A, capA)
  unregisterInstance(A, capA)
  check("注销后不可查", getInstanceByLocation(A) === undefined)
}

console.log("\n▶ 3. 同名 location 后登记覆盖前者（热重载语义）")
{
  __resetInstanceRegistryForTest()
  const oldCap = mkCap("old")
  const newCap = mkCap("new")
  registerInstance(A, oldCap)
  registerInstance(A, newCap)
  check("查到的是**新**登记（旧实例热重载后不再持有）", getInstanceByLocation(A) === newCap, "查到的不是 newCap")
  check("注册表条目数仍为 1（未残留两个）", listInstanceLocations().length === 1)
}

console.log("\n▶ 4. 旧实例注销不误删新登记（归属校验）")
{
  __resetInstanceRegistryForTest()
  const oldCap = mkCap("old")
  const newCap = mkCap("new")
  registerInstance(A, oldCap)
  registerInstance(A, newCap)      // 新实例接管
  unregisterInstance(A, oldCap)    // 旧实例随后卸载
  check("旧实例卸载后，新登记仍在", getInstanceByLocation(A) === newCap)
  check("且确实是新能力对象（未被误删成 undefined）", getInstanceByLocation(A) !== undefined)

  // 反向：能力对象相同（同一个）时，注销应生效
  __resetInstanceRegistryForTest()
  const cap = mkCap("x")
  registerInstance(A, cap)
  unregisterInstance(A, cap)
  check("同一能力对象注销应生效（不是永远不删）", getInstanceByLocation(A) === undefined)
}

console.log("\n▶ 5. 多 location 互不干扰")
{
  __resetInstanceRegistryForTest()
  const capA = mkCap("A")
  const capB = mkCap("B")
  registerInstance(A, capA)
  registerInstance(B, capB)
  check("A 查到自己的", getInstanceByLocation(A) === capA)
  check("B 查到自己的", getInstanceByLocation(B) === capB)
  unregisterInstance(A, capA)
  check("注销 A 不影响 B", getInstanceByLocation(B) === capB)
  check("A 已注销", getInstanceByLocation(A) === undefined)
}

console.log("\n▶ 6. list() 反映当前登记")
{
  __resetInstanceRegistryForTest()
  registerInstance(A, mkCap("A"))
  registerInstance(B, mkCap("B"))
  const list = listInstanceLocations().sort()
  check("列出两个 location", list.length === 2 && list[0] === A && list[1] === B, JSON.stringify(list))
}

console.log("\n▶ 7. 调用登记的能力确实打到目标对象（不串台）")
{
  __resetInstanceRegistryForTest()
  const hits: string[] = []
  const capA = mkCap("A", hits)
  const capB = mkCap("B", hits)
  registerInstance(A, capA)
  registerInstance(B, capB)

  // 模拟 owner 按「会话所属 location=B」路由
  const target = getInstanceByLocation(B)!
  await target.replyPermission({ sessionID: "ses_1", requestID: "per_1", decision: "once" })
  check("调用打到了 B 的能力对象（A 未被调用）", hits.length === 1 && hits[0] === "B:per_1", JSON.stringify(hits))
}

__resetInstanceRegistryForTest()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
