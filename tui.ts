/**
 * TUI/CLI 侧插件入口（opencode 2.x：`@opencode/plugin/tui`）
 *
 * ## 为什么需要这个入口
 *
 * `session.form.reply` 只存在于 TUI/CLI 插件上下文。本包的服务端入口（`index.ts`）
 * 负责接收手机命令，但服务端 ctx 是白名单字面量、**不含 form 域**，因此必须由
 * 终端进程里的这个入口代为投递。完整机制见 `doc/v2-plugin-form-mechanism.md`。
 *
 * ## 加载方式
 *
 * 暴露 `./tui` 的包由 CLI **自动加载**（官方《CLI plugins》），服务端配置
 * （`opencode.json` 的 `plugins`）里已有的这一条即可，无需登记 `cli.json`。
 * 已实测确认：加载后 CLI 侧插件对账数 +1，`setup` 被调用。
 *
 * ## 归属过滤（多终端竞争）
 *
 * 同一个 RPC 事件会被**所有在线终端客户端**收到。为了避免重复投递，这里按以下顺序判定
 * 「本次应答是否归本客户端处理」（design D2）：
 *
 * 1. **位置匹配（主判据）**：请求带 `locationDirectory` 时，仅有效位置等于该目录的客户端参与。
 * 2. **会话持有（次判据）**：请求未带位置时，仅**本地已加载该会话**的客户端参与。
 * 3. **不满足即静默**：不投递、不回调（服务端侧因此会走到超时，如实告知用户）。
 *
 * 兜底：若多个客户端同时满足（例如两个窗口在同一位置），第一个成功调用 `form.reply`
 * 的胜出；其余收到「已被结算」错误时**静默**，不重复投递、不产生噪音回执。
 *
 * ## 为什么消费方必须幂等
 *
 * 实测：同一事件载荷会被订阅方**反复收到**（重放）。因此本处理器对「已结算」错误静默，
 * 且并发重复调用由 `inFlight` 集合挡掉。
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { FormReplyRpc } from "./form-reply-rpc.js"
import type { FormReplyRequest } from "./form-reply-rpc.js"
import { info, warn } from "./log.js"

/** TUI 侧日志前缀（与服务端日志共用一个文件，便于对照因果顺序） */
function tlog(msg: string): void {
  info(`[tui] ${msg}`)
}

/** 判定「已被宿主结算」的错误：协议层 FormAlreadySettledError 的 `_tag`，或文案兜底 */
function isAlreadySettled(e: unknown): boolean {
  const parts: string[] = []
  if (e && typeof e === "object") {
    for (const k of ["_tag", "name", "message", "type", "code"]) {
      const v = (e as Record<string, unknown>)[k]
      if (typeof v === "string") parts.push(v)
    }
    // Effect Schema.Class 的 TaggedStruct 常把标签放在这些位置
    const nested = (e as { error?: unknown }).error
    if (nested && typeof nested === "object") {
      const t = (nested as Record<string, unknown>)._tag ?? (nested as Record<string, unknown>).type
      if (typeof t === "string") parts.push(t)
    }
  } else {
    parts.push(String(e))
  }
  return parts.some((p) => /Settled|already|已结算|已被(回答|取消)/i.test(p))
}

/** 把任意错误渲染成可读文本（Effect 错误 `String()` 会退化成 "[object Object]"） */
function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>
    const tag = o._tag ?? o.type ?? o.name
    const msg = o.message
    try {
      const json = JSON.stringify(e)
      return [tag, msg, json].filter((x) => typeof x === "string").join(" | ").slice(0, 400)
    } catch {
      return Object.keys(o).join(",") + `（无法序列化）`
    }
  }
  return String(e)
}

/** 回调服务端确认（失败只记日志：服务端会以超时如实告知，且投递结果不受影响） */
async function confirm(
  rpc: { confirm(input: { formID: string; ok: boolean; failureKind?: string }): Promise<unknown> },
  input: { formID: string; ok: boolean; failureKind?: string },
): Promise<void> {
  try {
    await rpc.confirm(input)
  } catch (e) {
    warn(`[tui] 回调确认失败 form=${input.formID} ok=${input.ok}: ${describeError(e)}`)
  }
}

/** 本客户端的有效位置（`context.location` 优先，回退到默认位置） */function effectiveLocation(context: Context): string | undefined {
  const fromInstance = context.location?.directory
  if (fromInstance) return fromInstance
  try {
    return context.data.location.default().directory
  } catch {
    return undefined
  }
}

/** 次判据：本客户端是否已加载该会话（先查缓存，未命中再 sync） */
async function holdsSession(context: Context, sessionID: string): Promise<boolean> {
  if (context.data.session.get(sessionID)) return true
  try {
    await context.data.session.sync(sessionID)
  } catch {
    // 该会话不属于本位置时 sync 会抛（实测 "Session not found"）→ 视为不持有
    return false
  }
  return context.data.session.get(sessionID) !== undefined
}

/** 归属判定（design D2） */
async function isOwnedByThisClient(context: Context, req: FormReplyRequest): Promise<boolean> {
  if (req.locationDirectory) {
    return effectiveLocation(context) === req.locationDirectory
  }
  return holdsSession(context, req.sessionID)
}

export default Plugin.define({
  id: "opencode-notify.tui",
  setup(context) {
    const rpc = context.client.rpc(FormReplyRpc)

    // 启动自检：验证「TUI → 服务端 method」路径可用（失败只记日志，不影响后续事件订阅）
    void rpc
      .ping({ ok: true })
      .then((r) => tlog(`自检 ping 成功 ok=${(r as { ok?: boolean }).ok} location=${effectiveLocation(context) ?? "(无)"}`))
      .catch((e: unknown) => warn(`[tui] 自检 ping 失败: ${describeError(e)}`))

    // 并发去重：防止同一 formID 的重放/并发触发重复投递。
    // （顺序重放由 isAlreadySettled 静默吸收，见文件头说明。）
    const inFlight = new Set<string>()

    const onSubmit = async (req: FormReplyRequest): Promise<void> => {
      if (!req.formID || !req.sessionID) return

      // 先判归属：不归本客户端 → 完全静默（不投递、不回调）
      let owned = false
      try {
        owned = await isOwnedByThisClient(context, req)
      } catch (e) {
        tlog(`归属判定异常 form=${req.formID}: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      if (!owned) {
        tlog(`非归属客户端，跳过 form=${req.formID} 本位置=${effectiveLocation(context) ?? "(无)"} 请求位置=${req.locationDirectory ?? "(无)"}`)
        return
      }
      if (inFlight.has(req.formID)) return
      inFlight.add(req.formID)
      try {
        // 第一步：真实投递。必须与下面的「回调确认」分开 ——
        // ⚠️ 投递成功但回调失败时，绝不能把它误报成投递失败：
        //    那会让服务端回执「应答失败、令牌未消费」，而表单其实已经被回答了（误导用户）。
        try {
          const form = context.data.session.form
          await form.reply({ sessionID: req.sessionID, formID: req.formID, answer: req.answer }, context.location)
        } catch (e) {
          if (isAlreadySettled(e)) {
            // 已被别的客户端抢先应答（或同一条被重放）→ 静默，不重复投递、不回执
            tlog(`已被结算，静默 form=${req.formID}`)
            return
          }
          warn(`[tui] 投递失败 form=${req.formID}: ${describeError(e)}`)
          // 如实回调失败，由服务端回执原因并保留令牌
          await confirm(rpc, { formID: req.formID, ok: false, failureKind: "error" })
          return
        }

        // 第二步：回调确认。到这里投递已成功，回调失败也不改变「已应答」这个事实。
        tlog(`投递成功 form=${req.formID}`)
        await confirm(rpc, { formID: req.formID, ok: true })
      } finally {
        inFlight.delete(req.formID)
      }
    }

    const off = rpc.events.on("request", (ev) => {
      tlog(`收到应答请求 form=${(ev.data as FormReplyRequest).formID}`)
      void onSubmit(ev.data as FormReplyRequest)
    })

    return () => {
      tlog("tui 插件卸载")
      off()
    }
  },
})
