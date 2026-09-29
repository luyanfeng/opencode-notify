## Why

**手机上的授权应答只在「插件活动实例恰好属于该会话所在目录」时才成功，否则一律失败。** 宿主对 `permission.reply` 有**按调用实例 location 的门控**：只有实例的 location 等于会话所属目录时，宿主才认这个请求；否则返回 `Permission request not found`。而插件是「每 location 一份实例、单例只选一个 owner」，owner 可能是任意目录 —— 于是同一操作时灵时不灵，且失败原因（"请求不存在"）会误导用户以为请求已过期。

实测（7 实例对照 + 6 次历史应答全量回归）：

- 同一权限请求，用 HTTP API 应答 → **成功**；用 owner 实例应答 → **`Permission request not found`**（证明门控在插件 ctx 的 host 层，不在 HTTP 层）
- 7 个实例同时尝试同一请求：**只有 `location == 会话 location` 的那个成功**，其余全部 `not found`
- **当时的 owner 属于别的 location，同样失败** —— 关键不是 owner 身份，而是 location 是否匹配
- 6 次历史应答与该规律 **6/6 一致**（owner 与会话同 location → 成功；不同 → 失败）

这是**日常路径**即可触发：只要你在别的项目里操作过（或曾用 `run --standalone` 打开过别的目录），owner 就可能不属于当前会话所在目录。

## What Changes

- **授权应答按会话所属 location 路由**：不再由「当前活动实例」直接应答，而是交给**该会话所属 location 的那个实例**去应答（复用进程级会合点，同 `process-singleton` / 表单应答等待表）。
- **新增进程级实例注册表**：每个实例在加载时登记自己的最小能力（**只暴露 `replyPermission`**，不暴露完整 ctx），卸载时注销。
- **应答前确定会话所属 location**：优先用事件载荷里已有的位置信息（`permission.asked` 顶层带 `location.directory`，与 `form.created` 同款），避免每次应答都去查会话。
- **目标目录没有实例时如实告知**：回执「该会话所在项目未打开终端，请先打开该项目后重试」，并**保留令牌**（TTL 内可重试）；不再笼统地报"请求不存在"。
- 不改变无归属令牌的**静默**策略；不新增命令通道（不是"每个实例都连一条 ntfy"）。

## Capabilities

### New Capabilities

- `permission-reply-routing`: 授权应答能够被投递到**会话所属 location 的实例**并成功执行；涵盖按位置路由、目标实例不存在时的如实告知、以及与既有凭证/归属机制的协同（含跨进程隔离不受影响）。

### Modified Capabilities

（无。`control-credential-sharing` 描述的是令牌跨 location 的有效性与进程级隔离，本次不改其契约；`remote-form-reply` 描述提问应答链路，本次不涉及。）

## Impact

**代码**
- 新增进程级实例注册表模块（如 `control/instance-registry.ts`）：`register/unregister/getByLocation`，会合点沿用 `globalThis`。
- `index.ts`：`setup` 时登记、cleanup 时注销；`bridge.replyPermission` 改为「解析会话 location → 查注册表 → 调目标实例」；目标不存在时抛带明确原因的错。
- `control/controller.ts` / `control/types.ts`：`replyPermission` 入参可能需要带上 `locationDirectory`（透传，与 `replyForm` 同构）；`PendingItem` 已有 `locationDirectory` 字段可复用。
- `events.ts` / `index.ts`：`permission.asked` 分支把事件顶层的 `location.directory` 存入待处理条目。

**兼容性 / 行为变化**
- **失败原因更准确**：原先失败的场景分化为「成功」与「明确告知未打开该项目」两类；不再出现误导性的 "request not found"。
- **新的失败面**：若该会话所属项目从未被打开（无实例），应答仍无法完成，但**如实告知**且令牌保留。

**风险（设计阶段需处理）**
- 依赖「能否读出会话所属 location」：事件载荷优先，若缺失需回退到查询会话；**该回退路径的 location 门控情况尚未实测**，须在实施首步验证。
- 进程级注册表需处理同名 location 的重复登记（热重载/重载时序）与陈旧引用。
- 授权应答属权限门禁路径，回归面覆盖所有授权操作。
