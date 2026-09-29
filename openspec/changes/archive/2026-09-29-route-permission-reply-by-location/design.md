## Context

见 `proposal.md — Why`。设计所需的现状约束（均已实测）：

- **`permission.reply` 按「实例 location」门控**：宿主只接受"实例 location == 会话所属目录"的调用，否则报 `Permission request not found`（7 实例对照实验）。
- **门控在插件 ctx 的 host 层**：同一请求用 HTTP API 应答成功，用插件实例应答失败。
- **关键不是 owner 身份**：当时的 owner 属于别的 location，同样失败；非 owner 但 location 匹配的实例成功。
- **`permission.asked` 事件顶层带 `location.directory`**（与 `form.created` 同款，schema 已确认）。
- **每 location 一份实例，但同进程共享 `globalThis`**；模块级变量在多实例下各求值一份，不可作会合点（既有结论）。
- **既有同族会合点先例**：`process-singleton.ts` 的 `__opencodeNotifyRuntime__`、`form-reply-bridge.ts` 的 `__opencodeNotifyFormReplyWaiters__`、`runtime-state.ts` 的 `__opencodeNotifyControlState__`。
- **form 应答不受该门控**（按 formID 在客户端侧定位），故本 change 不涉及 form。
- `PendingItem` 已有 `locationDirectory` 字段（为 form 归属判定而加），可直接复用。
- `control/` 层经 `OpencodeBridge` 窄接口调宿主；`replyPermission` 当前签名不带 location。

## Goals / Non-Goals

**Goals:**
- 授权应答不再受"活动实例属于哪个目录"影响，只要会话所属目录有实例就能成功。
- 目标目录无实例时给出准确、可操作的反馈，并保留令牌可重试。
- 失败原因分化清楚（成功 / 已结算 / 项目未打开 / 其它失败），不误导。
- 不破坏既有隔离与静默语义。

**Non-Goals:**
- 不新增命令通道（不做"每个实例都连一条 ntfy"）。
- 不改变 form 应答链路（它不受此门控）。
- 不引入 HTTP 直连宿主（实测插件 ctx 无 URL/认证，不可行）。
- 不做跨进程/跨机的应答转发。
- 不改令牌格式与凭证强制协议。

## Decisions

### D1. 路由机制：进程级实例注册表 + 直接调用目标实例（方案 E）

新增 `control/instance-registry.ts`，会合点 `globalThis.__opencodeNotifyInstances__`，形如 `Map<locationDirectory, { replyPermission }>`。

- 每个实例在 `setup` 时 `register(location, { replyPermission })`，在 cleanup 时 `unregister(location)`。
- 注册的接口**最小化**：只暴露 `replyPermission`，不暴露整个 ctx。
- owner 收到命令后：解析会话 location → `getByLocation(dir)` → 直接 `await target.replyPermission(...)`。

**为什么不用 RPC 派发（form 那套）**：RPC 事件是即发即忘、需回调确认与超时兜底；而这里目标是**同进程内存对象**，直接调用即可，零 RPC 基础设施、零等待。二者可行性等价，取更简单者。

**备选**：① 每实例都跑命令通道 —— 会产生 N 条长连接且破坏单例设计；② HTTP 直连 —— 前提不成立（无 URL/认证）；③ 跨实例共享 ctx —— 不可能。

### D2. 会话 location 的来源：优先事件载荷，回退查询会话

- `permission.asked` 事件顶层带 `location.directory` → 在登记待处理条目时存入 `PendingItem.locationDirectory`（复用既有字段）。
- 应答时优先用该值；若缺失，回退到查询会话的 location。

**⚠️ 待实施首步验证**：回退路径（查询会话）是否也受 location 门控。若受限则回退不可用，需改为"登记时若拿不到位置就明确报错"。（不改变本 design 的机制，只是兜底手段的可用性。）

### D3. 目标实例不存在 → 明确错误，保留令牌

`replyPermission` 在目标不存在时抛出**专用错误类型**（携带"项目未打开"语义），由 `control/` 层转成回执：
> 该会话所在项目未打开终端，请先打开该项目后重试

令牌**不消费**（与既有"执行成功才消费"一致）。

**为什么不能静默**：用户明知道自己在应答，静默会让他们以为手机没发出去。

### D4. 陈旧引用与重载时序

- 注册表以 location 为键，**后登记覆盖前者**（热重载时新实例覆盖旧实例的登记），避免同名 location 残留两个条目。
- `unregister` 前校验是否仍是自己（避免旧实例卸载时误删新实例的登记）。
- 拿到引用后调用失败（实例已被卸载/替换）→ 宿主会拒绝 → 按"其它执行失败"如实回执。

### D5. 失败原因分化（回执措辞）

`control/` 层已有"成功才消费令牌、失败回执原因"的框架，只需让错误类型可区分：

| 结果 | 回执 |
|---|---|
| 成功 | 已允许/已拒绝 <令牌> |
| 宿主已结算 | …失败（令牌未消费）：该请求已被处理或已取消 |
| 目标项目未打开 | …失败（令牌未消费）：该会话所在项目未打开终端，请先打开该项目后重试 |
| 其它 | …失败（令牌未消费）：<原因> |

### D6. 不改动的东西

- 令牌格式、凭证强制协议、静默策略、跨进程隔离（`runtime-state.ts` 的进程级状态）、form 应答链路。

## Risks / Trade-offs

- [回退路径（查询会话 location）可能也受门控] → 实施首步验证；不可用则以事件载荷为准并在缺失时明确报错。
- [注册表以 location 为键，同名 location 覆盖] → 顺序由宿主加载/重载决定，后加载者胜；`unregister` 校验归属，避免误删。
- [会话 location 与实例 location 字符串不完全一致（软链接/尾斜杠）] → 需实测比对口径；必要时规范化（不引入过度抽象）。
- [权限门禁路径回归面大] → 用真实实例注册表做冒烟（路由选择/无实例/覆盖/注销），并做端到端复现（owner ≠ 会话 location → 成功）。
- [目标项目未打开时的体验仍是"不能应答"] → 与现状一致，但**原因准确且令牌可重试**；文档需说明该前提。

## Migration Plan

- **兼容性**：纯内部路由调整，无配置格式/对外接口变化。
- **部署**：热重载或重启服务即可。
- **回滚**：把 `replyPermission` 恢复为直接调 `ctx.permission.reply` 即可（注册表可保留不用）。
- **验证顺序**：① 前提验证（会话 location 读取路径）→ ② 注册表单测 → ③ 端到端复现（owner ≠ 会话 location）→ ④ 边界（无实例/已结算）→ ⑤ 回归（TSC + 五个冒烟 + 跨进程）。

## Open Questions

（无。方案已用两轮推演自证，含 10 项断言；唯一的实测不确定点（回退路径门控）已列为实施首步验证，不影响机制选择。）
