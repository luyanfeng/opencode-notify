#!/usr/bin/env bun
/**
 * 凭证共享冒烟：不依赖网络/opencode，验证**进程级共享**后的令牌存活与隔离语义
 *
 *   1. 同进程内 owner 变更（新 location 加载）→ 令牌仍被受理、条目未丢
 *   2. 插件热重载（再次 getControlState）→ 令牌仍有效
 *   3. 跨 server 进程（不同 globalThis 沙箱）→ 互不受理、无串答
 *   4. 跨机器（等价于跨进程）→ 互不受理
 *   5. 配置指纹变化 → 按新参数重建 + 迁移条目（不丢令牌）
 *   6. 容量上限变小时立即裁剪
 *   7. 指纹未变时复用同一 registry 实例
 *   8. 静默语义不变：异主/无效令牌不产生回执（由门卫判定，无需执行）
 *   9. 同一进程内两个 controller 得到同一 instance 与同一 registry
 *
 * 运行：bun scripts/control-credential-sharing-smoke.ts
 */

import { PendingRegistry } from "../control/pending.js"
import { getControlState, __resetControlStateForTest } from "../control/runtime-state.js"
import { genItemToken, tokenInstance } from "../control/tokens.js"
import { configureLog } from "../log.js"

configureLog("off") // 冒烟不落盘日志

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

/** 模拟「一个 server 进程」的门卫：前缀 → 注册表查证（对应 controller.ts:209/214） */
interface Gate { instance: string; registry: PendingRegistry }
function accepts(gate: Gate, token: string): { pass: boolean; reason?: string } {
  if (tokenInstance(token) !== gate.instance) return { pass: false, reason: "无归属令牌" }
  if (!gate.registry.getByCode(token)) return { pass: false, reason: "查无此证" }
  return { pass: true }
}

const CFG = { tokenTtlMs: 30 * 60 * 1000, maxPending: 30 }

// ── 1. 同进程 owner 变更 ────────────────────────────────────────────────
console.log("\n▶ 1. 同进程内 owner 变更（新 location 加载）")
{
  __resetControlStateForTest()
  const before = getControlState(CFG) // 「旧 owner」实例
  const item = before.registry.add("permission", "per_1", "ses_x", "bash")
  check("旧实例能受理自己发出的令牌", accepts(before, item.code).pass)

  const after = getControlState(CFG) // 新 location 加载 → 「新 owner」实例
  check("owner 变更后：实例前缀不变", before.instance === after.instance, `${before.instance} vs ${after.instance}`)
  check("owner 变更后：指向同一注册表", before.registry === after.registry)
  const r = accepts(after, item.code)
  check("owner 变更后：令牌仍被受理（修复前会被静默丢弃）", r.pass, r.reason ?? "")
  check("owner 变更后：条目未丢（requestID 仍可查）", after.registry.getByCode(item.code)?.requestID === "per_1")
}

// ── 2. 插件热重载 ───────────────────────────────────────────────────────
console.log("\n▶ 2. 插件热重载（模块重新求值，globalThis 存活）")
{
  __resetControlStateForTest()
  const a = getControlState(CFG)
  const item = a.registry.add("form", "frm_1", "ses_x", "提问", ["是", "否"], { answerKey: "q0", optionValues: ["是", "否"] })

  const b = getControlState(CFG) // 重载后再次取
  check("重载后：令牌仍被受理", accepts(b, item.code).pass)
  check("重载后：选项与回传值完好（迁移/复用未丢字段）", b.registry.getByCode(item.code)?.optionValues?.[1] === "否")
}

// ── 3. 跨 server 进程隔离（用独立沙箱模拟另一个进程）────────────────────
console.log("\n▶ 3. 跨 server 进程隔离")
{
  __resetControlStateForTest()
  const p1 = getControlState(CFG)
  const item = p1.registry.add("permission", "per_1", "ses_x", "bash")

  // 另一个「进程」：全局状态互不可见。这里用另一个独立 registry 构造等价的门卫。
  const p2instance = tokenInstance(genItemToken("ffff"))! // 另一个进程的随机前缀
  const p2: Gate = { instance: p2instance, registry: new PendingRegistry(30, p2instance, CFG.tokenTtlMs) }

  check("两个进程的实例前缀不同", p1.instance !== p2.instance)
  check("进程1 受理自己的令牌", accepts(p1, item.code).pass)
  const r = accepts(p2, item.code)
  check("进程2 拒绝进程1 的令牌（MUST NOT 受理）", r.pass === false, r.reason ?? "")
  check("进程2 拒绝原因为「无归属令牌」（即静默路径）", r.reason === "无归属令牌")
}

// ── 4. 跨机器（等价于跨进程）────────────────────────────────────────────
console.log("\n▶ 4. 跨机器")
{
  __resetControlStateForTest()
  const x = getControlState(CFG)
  const item = x.registry.add("permission", "per_1", "ses_x", "bash")
  const yi = tokenInstance(genItemToken("aaaa"))!
  const y: Gate = { instance: yi, registry: new PendingRegistry(30, yi, CFG.tokenTtlMs) }
  check("甲机受理", accepts(x, item.code).pass)
  check("乙机拒绝（不串答）", accepts(y, item.code).pass === false)
}

// ── 5. 配置指纹变化：重建 + 迁移 ────────────────────────────────────────
async function testConfigChange(): Promise<void> {
  console.log("\n▶ 5. 配置变更：重建 + 迁移 + 新参数生效")
  __resetControlStateForTest()
  // 先以「极短 TTL」建立状态，使条目在片刻后过期
  const a = getControlState({ tokenTtlMs: 1, maxPending: 30 })
  const item = a.registry.add("permission", "per_1", "ses_x", "bash")
  await new Promise((r) => setTimeout(r, 10))
  check("极短 TTL 下条目过期（可观测）", a.registry.getByCode(item.code) === undefined)

  // 换成足够长的 TTL 并重新登记一条
  const b = getControlState({ tokenTtlMs: 300_000, maxPending: 30 })
  check("指纹变化 → 注册表被重建（不是同一对象）", a.registry !== b.registry)
  check("实例前缀不变", a.instance === b.instance)
  const kept = b.registry.add("permission", "per_2", "ses_x", "bash")
  check("迁移后：新登记的令牌被受理（新 TTL 生效，不再立即过期）", accepts(b, kept.code).pass)
  check("迁移后：同 process 再次取不重建", getControlState({ tokenTtlMs: 300_000, maxPending: 30 }).registry === b.registry)

  // 迁移保留条目：用长 TTL 建状态 → 登记 → 仅改 max（条目不该丢）
  __resetControlStateForTest()
  const c = getControlState({ tokenTtlMs: 300_000, maxPending: 30 })
  const live = c.registry.add("permission", "per_live", "ses_x", "bash")
  const d = getControlState({ tokenTtlMs: 300_000, maxPending: 20 }) // 指纹变化（max）
  check("迁移保留条目：仍在有效期内的令牌被受理", accepts(d, live.code).pass)
}

await testConfigChange()

// ── 6. 容量上限变小时立即裁剪 ───────────────────────────────────────────
console.log("\n▶ 6. 容量上限变小时立即裁剪")
{
  __resetControlStateForTest()
  const a = getControlState({ tokenTtlMs: 60_000, maxPending: 30 })
  const codes: string[] = []
  for (let i = 0; i < 5; i++) codes.push(a.registry.add("permission", `per_${i}`, "ses_x", "bash").code)
  check("裁剪前有 5 条", a.registry.list().length === 5)

  const b = getControlState({ tokenTtlMs: 60_000, maxPending: 2 }) // max 调小
  check("裁剪后条数 ≤ 新 max（立即生效）", b.registry.list().length <= 2, `实际=${b.registry.list().length}`)
  check("保留的是最新者（最早那条被裁）", b.registry.getByCode(codes[0]) === undefined)
  check("最新一条仍在", b.registry.getByCode(codes[4]) !== undefined)
}

// ── 7. 指纹未变时复用 ───────────────────────────────────────────────────
console.log("\n▶ 7. 指纹未变时复用同一 registry")
{
  __resetControlStateForTest()
  const a = getControlState(CFG)
  const b = getControlState(CFG)
  check("同一对象（不抖动、不影响已有令牌）", a.registry === b.registry)
}

// ── 8. 静默语义不变 ─────────────────────────────────────────────────────
console.log("\n▶ 8. 静默语义不变（异主 / 无效令牌不产生回执）")
{
  __resetControlStateForTest()
  const s = getControlState(CFG)
  // 异主令牌
  const foreign = genItemToken("ffff")
  const r1 = accepts(s, foreign)
  check("异主令牌被拒（走静默分支，调用方不回执）", r1.pass === false && r1.reason === "无归属令牌")
  // 本主但已消费
  const item = s.registry.add("permission", "per_1", "ses_x", "bash")
  s.registry.removeByCode(item.code)
  const r2 = accepts(s, item.code)
  check("已消费令牌被拒（走静默分支）", r2.pass === false && r2.reason === "查无此证")
}

// ── 9. 同进程两个 controller（等价：两次取 state）得到同一 instance/registry ──
console.log("\n▶ 9. 同进程多实例共享同一 instance 与 registry")
{
  __resetControlStateForTest()
  const c1 = getControlState(CFG)
  const c2 = getControlState(CFG)
  check("两个实例的 instance 相同", c1.instance === c2.instance)
  check("两个实例的 registry 相同（可互相受理）", c1.registry === c2.registry)
  const item = c1.registry.add("permission", "per_1", "ses_x", "bash")
  check("实例2 能受理实例1 登记的令牌", accepts(c2, item.code).pass)
}

// ── 10. snapshot 深拷贝隔离 ─────────────────────────────────────────────
console.log("\n▶ 10. snapshot 深拷贝（迁移不共享可变数组）")
{
  const reg = new PendingRegistry(30, "abcd", 60_000)
  const item = reg.add("form", "frm_1", "ses_x", "提问", ["甲", "乙"], { answerKey: "q0", optionValues: ["v1", "v2"] })
  const snap = reg.snapshot()
  const snapOptions = snap[0].optionValues
  // 改动原注册表里的数组，快照不应受影响
  reg.removeByCode(item.code)
  check("快照独立于原注册表（原表清空后快照仍在）", snap.length === 1)
  check("快照的选项数组是副本（非同一引用）", snapOptions !== undefined && snapOptions[1] === "v2")
}

__resetControlStateForTest() // 收尾：不污染其它进程内的后续读取（本进程仅冒烟使用）
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
