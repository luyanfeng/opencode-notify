#!/usr/bin/env bun
/**
 * 表单应答桥冒烟（服务端侧）：不依赖网络/opencode，验证
 *   1. 注册与成功确认 → resolve
 *   2. 失败确认（settled）→ reject 且携带 failureKind
 *   3. 超时（无 TUI）→ FormReplyTimeoutError（提示回电脑处理）
 *   4. 同 formID 复用 → 只派发一次，两次调用同结果
 *   5. 无等待者的确认 → 忽略（不抛错）
 *   6. 未注册 / 入参不完整 → 立即失败
 *   7. dispose → 等待者立即失败并注销注册
 *   8. 派发失败 → 立即失败且不残留等待者（无 unhandledRejection）
 *
 * 运行：bun scripts/form-reply-bridge-smoke.ts
 */

import { FormReplyBridge, FormReplyTimeoutError, FormReplyFailedError } from "../form-reply-bridge.js"
import type { FormReplyRpcHost, RpcRegistrationHandle } from "../form-reply-bridge.js"
import { configureLog } from "../log.js"

configureLog("off")

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name} ${detail}`)
  }
}

/** 造一个可手动触发 confirm 的假 host */
function makeHost(): {
  host: FormReplyRpcHost
  emitted: Array<{ formID: string }>
  confirm: (input: unknown) => Promise<{ ok: boolean }>
  disposeCount: () => number
} {
  const emitted: Array<{ formID: string }> = []
  let disposeCount = 0
  let capturedConfirm: (input: unknown) => Promise<{ ok: boolean }> = async () => ({ ok: true })

  const registration: RpcRegistrationHandle = {
    dispose: async () => {
      disposeCount += 1
    },
    events: {
      emit: async (_name: "request", payload: { formID: string }) => {
        emitted.push({ formID: payload.formID })
      },
    },
  }

  const host: FormReplyRpcHost = {
    rpc: {
      register: async (_def, handlers) => {
        capturedConfirm = handlers.confirm as (input: unknown) => Promise<{ ok: boolean }>
        return registration
      },
    },
  }

  return { host, emitted, confirm: (i) => capturedConfirm(i), disposeCount: () => disposeCount }
}

async function main(): Promise<void> {
  console.log("=== 1. 注册 + 成功确认 ===")
  {
    const { host, emitted, confirm } = makeHost()
    const bridge = new FormReplyBridge(2000)
    await bridge.register(host)
    check("注册后无等待者", bridge.pendingCount === 0)

    const p = bridge.request({ formID: "f1", sessionID: "s1", answer: { q0: "a" } })
    check("派发一次 emit", emitted.length === 1, `实际=${emitted.length}`)
    check("存在 1 个等待者", bridge.pendingCount === 1, `实际=${bridge.pendingCount}`)

    await confirm({ formID: "f1", ok: true })
    let ok = true
    await p.catch(() => { ok = false })
    check("ok:true 时 resolve", ok)
    check("确认后等待者清空", bridge.pendingCount === 0)
  }

  console.log("=== 2. 失败确认（settled）===")
  {
    const { host, confirm } = makeHost()
    const bridge = new FormReplyBridge(2000)
    await bridge.register(host)

    const p = bridge.request({ formID: "f2", sessionID: "s1", answer: { q0: "a" } })
    await confirm({ formID: "f2", ok: false, failureKind: "settled" })
    let err: Error | undefined
    await p.catch((e: Error) => { err = e })
    check("ok:false 时 reject", !!err)
    check("错误类型为 FormReplyFailedError", err instanceof FormReplyFailedError)
    check("failureKind=settled", (err as FormReplyFailedError)?.failureKind === "settled")
    check("错误信息含「已被回答或已取消」", !!err?.message.includes("已被回答或已取消"), err?.message)
  }

  console.log("=== 3. 超时（无 TUI）===")
  {
    const { host } = makeHost()
    const bridge = new FormReplyBridge(150)
    await bridge.register(host)

    const p = bridge.request({ formID: "f3", sessionID: "s1", answer: { q0: "a" } })
    let err: Error | undefined
    await p.catch((e: Error) => { err = e })
    check("超时 reject", !!err)
    check("错误类型为 FormReplyTimeoutError", err instanceof FormReplyTimeoutError)
    check("错误信息提示回电脑处理", !!err?.message.includes("请回电脑处理"), err?.message)
    check("超时后等待者清空", bridge.pendingCount === 0)
  }

  console.log("=== 4. 同 formID 复用（不重复派发）===")
  {
    const { host, emitted, confirm } = makeHost()
    const bridge = new FormReplyBridge(2000)
    await bridge.register(host)

    const p1 = bridge.request({ formID: "f4", sessionID: "s1", answer: { q0: "a" } })
    const p2 = bridge.request({ formID: "f4", sessionID: "s1", answer: { q0: "a" } })
    check("只派发一次 emit", emitted.length === 1, `实际=${emitted.length}`)
    check("等待者仅 1 个", bridge.pendingCount === 1)

    await confirm({ formID: "f4", ok: true })
    const r = await Promise.allSettled([p1, p2])
    check("两次调用都 resolve", r.every((x) => x.status === "fulfilled"), JSON.stringify(r.map((x) => x.status)))
  }

  console.log("=== 5. 无等待者的确认（迟到/重复）被忽略 ===")
  {
    const { host, confirm } = makeHost()
    const bridge = new FormReplyBridge(2000)
    await bridge.register(host)
    // 没有任何 request 就直接 confirm
    const res = await confirm({ formID: "nobody", ok: true })
    check("无等待者确认返回 ok:true（不抛错）", res.ok === true)
    check("不产生等待者", bridge.pendingCount === 0)
  }

  console.log("=== 6. 未注册时 request 直接失败 ===")
  {
    const bridge = new FormReplyBridge(2000)
    let err: Error | undefined
    await bridge.request({ formID: "f6", sessionID: "s1", answer: { q0: "a" } }).catch((e: Error) => { err = e })
    check("未注册 → FormReplyFailedError", err instanceof FormReplyFailedError, String(err))
    check("信息含「通道尚未就绪」", !!err?.message.includes("通道尚未就绪"), err?.message)
  }

  console.log("=== 7. 入参不完整 ===")
  {
    const { host } = makeHost()
    const bridge = new FormReplyBridge(2000)
    await bridge.register(host)
    let err: Error | undefined
    await bridge.request({ formID: "", sessionID: "s1", answer: { q0: "a" } }).catch((e: Error) => { err = e })
    check("空 formID → 失败", err instanceof FormReplyFailedError, String(err))
  }

  console.log("=== 8. dispose 让等待者立即失败并注销 ===")
  {
    const { host, disposeCount } = makeHost()
    const bridge = new FormReplyBridge(5000)
    await bridge.register(host)
    const p = bridge.request({ formID: "f8", sessionID: "s1", answer: { q0: "a" } })
    bridge.dispose()
    let err: Error | undefined
    await p.catch((e: Error) => { err = e })
    check("dispose 后等待者立即 reject（不等超时）", err instanceof FormReplyFailedError, String(err))
    check("dispose 调用了注册句柄", disposeCount() === 1, `实际=${disposeCount()}`)
    check("等待者清空", bridge.pendingCount === 0)
  }

  console.log("=== 9. 派发失败时等待者立即失败（不悬挂）===")
  {
    const flaky: FormReplyRpcHost = {
      rpc: {
        register: async () => ({
          dispose: async () => {},
          events: { emit: async () => { throw new Error("boom") } },
        }),
      },
    }
    const bridge = new FormReplyBridge(5000)
    await bridge.register(flaky)
    let err: Error | undefined
    await bridge.request({ formID: "f9", sessionID: "s1", answer: { q0: "a" } }).catch((e: Error) => { err = e })
    check("emit 抛错 → reject", err instanceof FormReplyFailedError, String(err))
    check("信息含「派发应答请求失败」", !!err?.message.includes("派发应答请求失败"), err?.message)
    check("不残留等待者", bridge.pendingCount === 0)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
