## Context

见 `proposal.md — Why`。设计所需的现状约束（均已核实）：

- 每 location 一份插件实例；`ControlController` 的 `instance = newInstanceId()` 与 `registry = new PendingRegistry(...)` 都是**实例私有**（`controller.ts:45/54`）。
- 令牌门卫两道，均在**实例**上比对：前缀（`controller.ts:209`）、注册表查证（`controller.ts:214`）。
- **只有 owner 会写注册表**：`index.ts` 的 `finishNotification` 开头 `if (!singleton.isActive()) return`，而所有 `registerPending` 都在其后（`:126` vs `:340/:376`）。
- **应答调用是 server 级的**：`adapter.js` 里 `location: host.location` 只挂在 ctx 上，`permission.reply` / `session.interrupt` 调用时**不传 location**（`adapter.js:308/427`）。即同进程任一实例都能为任意会话执行应答。
- 既有进程级会合点先例：`process-singleton.ts` 的 `__opencodeNotifyRuntime__`、`form-reply-bridge.ts` 的 `__opencodeNotifyFormReplyWaiters__`；模块级变量在多实例下不共享（同一 entrypoint 被求值成多份），`globalThis` 才是进程级共享的。
- 同机多 server 进程是真实场景（`serve --port`、`run --standalone`；`store.ts` 已用 O_EXCL 处理跨进程去重）。

## Goals / Non-Goals

**Goals:**
- 令牌在同一 server 进程内跨 location 存活（owner 变更、热重载、配置变更后仍可用）。
- 跨 server 进程 / 跨机器严格隔离，且不新增回执噪音。
- 配置变更（有效期、容量）能按新参数生效且不丢已发出令牌。

**Non-Goals:**
- 不做跨进程/跨机的状态共享（那会破坏隔离，且与 `store.ts` 的 O_EXCL 去重职责冲突）。
- 不改变新的 form 应答链路（`form-reply-bridge.ts` 的等待表已是进程级）。
- 不改变「无归属令牌一律静默」策略。
- 不引入持久化（进程退出即清空是有意为之：令牌本就只对「运行中的进程」有意义）。

## Decisions

### D1. 会合点：新建 `control/runtime-state.ts`，把 instance 与 registry 放 `globalThis`

键名沿用既有前缀风格：`__opencodeNotifyControlState__`，形如 `{ instance: string, registry: PendingRegistry, fingerprint: string }`。

**为什么新建模块而不是并入 `tokens.ts`**：`tokens.ts` 职责是"生成与解析令牌"（纯函数），把生命周期状态塞进去会混淆职责；`runtime-state.ts` 集中承载"进程级共享状态"这一横切关注点，与 `process-singleton.ts` / `form-reply-bridge.ts` 的会合点模式一致。

**备选**：① 并入 `tokens.ts` —— 职责混杂；② 用 `ctx.storage` —— 实测按 location 隔离，不可用；③ 用模块级变量 —— 实测多实例下被求值成多份，不共享。

### D2. 谁写、谁读：维持"只有 owner 写"，读侧任意实例

- **写**：仅 owner 实例（`isActive()` 闸门保证）调用 `registerPending` / `resolvePending`。
- **读/受理**：命令通道只有 owner 在跑，因此**实际受理者也是 owner**；共享的意义在于 owner 变更后**新 owner 能读到旧 owner 写入的条目**。

**为什么不需要额外加锁**：JS 单线程；写入仅由唯一 owner 在事件回调里同步完成，不存在并发写。共享注册表不会让"本应隔离的两份控制逻辑"共存——同一进程内只存在一份命令通道（单例保证）。

### D3. 配置变更：指纹 + 重建 + 迁移

指纹 = `token_ttl_ms` + `max_pending`（序列化后比对）。

```
getControlState(config):
  if 无状态 → 新建（instance + registry + fingerprint）
  else if fingerprint 未变 → 直接返回既有状态
  else → 快照旧条目 → 按新参数新建 registry → 恢复条目 → 显式裁剪一次 → 更新 fingerprint
```

**为什么必须迁移而不是重建就丢**：直接重建会让已发出的令牌立刻失效 —— 正是本次要修的问题的另一种形式。

**为什么需要显式裁剪**：`PendingRegistry.add()` 的裁剪只在 push 之后触发；迁移不走 `add`，因此 `max` 变小时必须显式裁一次，否则新上限不生效。

**已知语义**（写进文档）：TTL 变更会影响**存量**条目的过期判定（变大可能让原本过期的"复活"，变小则立即过期）。这是配置变更的固有语义，且只在用户主动改配置时发生，可接受。

### D4. 隔离边界：进程 = `globalThis` 的天然边界

`globalThis` 是每进程独立的，因此"进程级共享"自动满足"跨进程隔离"。多机器则天然是不同进程。**不需要额外机制**。

### D5. `PendingRegistry` 只加最小能力，不改既有行为

新增 `snapshot()` / `restore()`（或等价的最小接口）供 D3 迁移使用；**不改** `add` 的幂等逻辑、`consume` 语义、`prune` 的 TTL 判定（除 D3 要求的显式裁剪入口）。

## Risks / Trade-offs

- [共享注册表可能让本应隔离的逻辑互相干扰] → 当前不存在该场景（只有 owner 写、只有 owner 跑命令通道）；在 `runtime-state.ts` 顶部写明"写侧约束：仅 owner"。
- [进程退出后令牌全丢] → 有意为之：令牌只对运行中的进程有意义；与既有行为一致（内存注册表本来就不持久化）。
- [TTL 变更影响存量条目的判定] → 固有语义，文档写明；实现上不做特殊兼容（避免引入隐性规则）。
- [`globalThis` 键名污染或被外部误用] → 键名带 `__opencodeNotify` 前缀；模块顶部注释说明归属。
- [热重载后 `instance` 前缀不变，旧日志前缀会"复用"] → 无功能影响；仅影响日志可读性，日志同时会打印 location，足以区分。
- [回归风险：改动集中在凭证门卫，波及所有权限/提问应答] → 用真实 `PendingRegistry` 把两轮推演固化为冒烟（owner 变更 / 热重载 / 跨进程 / 配置迁移 / 静默），并做端到端复现验证。

## Migration Plan

- **兼容性**：纯内部状态位置调整，无对外接口/配置格式变化。
- **部署**：热重载或重启服务即可；**首次加载时**若已有旧实例状态（同一进程内），新逻辑会以当前配置建立共享状态，旧实例的私有注册表内容**不会自动并入**（一次性影响：升级瞬间的待处理令牌可能失效）。这是可接受的升级边界，需在发布说明中提及。
- **回滚**：把 `instance` / `registry` 改回实例私有即可。

## Open Questions

（无。方案的两处不确定点——配置迁移是否会丢条目、跨进程隔离是否被破坏——已用仿真自证：31 项断言全通过。实现时按 tasks 复测即可。）
