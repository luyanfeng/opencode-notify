/**
 * 服务端 ↔ TUI 的 RPC 契约（包内共享）
 *
 * ## 为什么需要
 *
 * `session.form.reply` 只存在于 TUI/CLI 插件上下文，服务端插件 ctx 是白名单字面量、不含 form 域。
 * 本包因此有两个入口：`index.ts`（服务端）与 `tui.ts`（TUI）。两端通过本文件定义的
 * RPC 协作：服务端**注册**并派发请求，TUI **订阅**并执行应答后回调确认。
 *
 * ## 为什么两端共用同一个 definition 对象
 *
 * 客户端的 `client.rpc(D)` 从 D 推导方法/事件名与载荷类型；若两端各写一份，
 * id 或字段名不一致会在运行时静默失配（事件收不到、方法找不到）。共用一份是唯一能避免的做法。
 *
 * ## 事件会重放
 *
 * 实测（探针 PROBE12）：同一 event 载荷会在不同时刻被订阅方反复收到。
 * 因此消费方必须幂等 —— 这正是 `request` 的 TUI 侧要按归属过滤、并对
 * 「已结算」错误静默处理的原因（见 `tui.ts`）。
 */

import { Rpc } from "@opencode/plugin/rpc"

/** 应答请求载荷：服务端 → TUI */
export interface FormReplyRequest {
  /** 目标表单 ID（宿主用它定位 form） */
  formID: string
  /** 目标表单所属会话 */
  sessionID: string
  /** 提交给宿主的答案：键为表单字段 key（question 工具为 q0/q1/…），值为选项提交值或自由文本 */
  answer: Record<string, string | number | boolean | ReadonlyArray<string>>
  /** 表单所在位置目录（用于归属判定；缺失时 TUI 回退到会话持有判据） */
  locationDirectory?: string
  /** 允许赋给 RPC 事件的 `Readonly<Record<string, unknown>>` 载荷类型 */
  [key: string]: unknown
}

/** 应答结果回调：TUI → 服务端 */
export interface FormReplyConfirmation {
  /** 对应的应答请求（与 request.formID 一致） */
  formID: string
  /** 是否成功投递给宿主 */
  ok: boolean
  /** ok=false 时的失败类别，用于服务端回执措辞 */
  failureKind?: "settled" | "error"
}

const requestSchema = {
  type: "object",
  properties: {
    formID: { type: "string" },
    sessionID: { type: "string" },
    answer: { type: "object" },
    locationDirectory: { type: "string" },
  },
  required: ["formID", "sessionID", "answer"],
  additionalProperties: false,
} as const

const confirmSchema = {
  type: "object",
  properties: {
    formID: { type: "string" },
    ok: { type: "boolean" },
    failureKind: { type: "string" },
  },
  required: ["formID", "ok"],
  additionalProperties: false,
} as const

const ackSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const

/**
 * 表单应答 RPC。
 *
 * - `events.request`：服务端派发应答请求，TUI 订阅。
 * - `methods.confirm`：TUI 完成投递后回调服务端，使服务端能判定成功/失败/超时。
 * - `methods.ping`：连通性探测（TUI 可主动调用，验证与服务的连接可用）。
 */
export const FormReplyRpc = Rpc.define({
  id: "opencode-notify.form-reply",
  methods: {
    confirm: { input: confirmSchema, output: ackSchema },
    ping: { input: ackSchema, output: ackSchema },
  },
  events: {
    request: { schema: requestSchema },
  },
})
