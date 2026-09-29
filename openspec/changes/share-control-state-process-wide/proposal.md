## Why

**已发出的应答令牌会在用户完全无感的情况下失效。** 每当宿主加载一个新的 location（例如你打开另一个项目目录、或用 `opencode run --standalone` / 另起 `serve --port`），本插件就会多出一个实例并按「最新注册者夺权」成为活动实例；而**实例前缀与待处理注册表都是实例私有的**，于是先前那个实例登记的所有权限/提问令牌立刻作废。手机端点按之后走「无归属令牌」分支被**静默丢弃**——不回执、不报错，用户无从得知为什么没反应。

实测复现（`plugin.log`）：新 location 加载后 owner 换人、实例前缀由 `5785` 变为 `5f1a`，2 秒后手机命令即被 `忽略无归属令牌消息 … 本实例=5f1a` 丢弃。这是日常操作（打开新项目）即可触发的路径。

## What Changes

- **实例前缀与待处理注册表改为进程级共享**：同一 server 进程内所有 location 实例共用同一前缀与同一份注册表，使 owner 变更不再让已发出的令牌失效。
- **配置变更时重建注册表并迁移条目**：以 `token_ttl_ms` + `max_pending` 为指纹；指纹变化才按新参数重建，且**先快照、再恢复**，不丢已发出的令牌。
- **保留跨进程与跨机器隔离**：共享范围严格限于「一个 server 进程」（会合点用 `globalThis`，每进程独立），多 server 进程/多机器之间仍互不受理。
- **新增进程级状态模块** `control/runtime-state.ts`：集中承载会合点与注册表生命周期，避免把进程级状态散进 `tokens.ts`。
- 不改变无归属令牌的**静默**策略（修好后误判来源已消除；静默仍是防跨机串答的正确行为）。

## Capabilities

### New Capabilities

- `control-credential-sharing`: 远程控制凭证（一次性令牌）与待处理请求在同一 server 进程内的**跨 location 有效性**，以及在多 server 进程 / 多机器之间保持隔离；涵盖 owner 变更、插件热重载、配置变更迁移等场景下的令牌存活语义。

### Modified Capabilities

（无。本项目尚无既有 spec；上一个 change `add-tui-form-reply` 建立的 `remote-form-reply` 能力描述的是应答链路行为，本次不改其契约。）

## Impact

**代码**
- 新增 `control/runtime-state.ts`（进程级会合点：instance 前缀 + 注册表 + 配置指纹）。
- `control/controller.ts`：`instance` 与 `registry` 改为从进程级状态取（`this.instance` / `new PendingRegistry(...)` 两处）。
- `control/pending.ts`：新增最小能力以支持「重建 + 迁移」（快照/恢复/显式裁剪一次），不改既有行为。
- `control/tokens.ts`：`newInstanceId()` 的调用点迁到进程级状态模块（函数本身不变）。

**兼容性 / 行为变化**
- **令牌语义变化（对用户有利）**：owner 变更、热重载后，已发出的令牌**继续有效**，不再静默失效。
- **配置变更语义**：`token_ttl_ms` 变更会影响**存量**条目的过期判定（TTL 变大可能让原本过期的条目"复活"，变小则立即过期）；`max_pending` 变小时存量条目会被裁到新上限。这是配置变更的固有语义，需在文档写明。
- **运维事实**：因 `globalThis` 在进程内存活，热重载后**注册表沿用既有实例**；指纹变化时才会重建（因此配置改动无需重启即可生效，而其它 per-instance 状态不受影响）。

**风险**
- 共享注册表后，若同一进程内**本应隔离**的两份控制逻辑共存（当前不存在：只有 owner 会写，且命令通道只有 owner 在跑），可能互相干扰 —— 需在 design 中明确「谁写、谁读」并加约束。
- 会合点键名与既有 `__opencodeNotifyRuntime__` / `__opencodeNotifyFormReplyWaiters__` 一致的命名与复用策略需统一。
