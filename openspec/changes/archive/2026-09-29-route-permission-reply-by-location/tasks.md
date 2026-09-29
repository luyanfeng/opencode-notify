## 1. 前提验证（决定回退路径是否可用）

- [x] 1.1 实测 `ctx.session.get({sessionID})` 能否读出**其它 location** 的会话（是否受 location 门控），并记录返回里的 location 字段名 —— 验证：拿到结论（能/不能 + 字段名）
  - 结果：**不受门控，可用**。6 个实例（含 5 个非该会话所属 location）全部成功读出，返回的 location 字段为 `session.location.directory`。故 design D2 的回退路径成立。⚠️ 注意 `ctx.session.get()` 返回的会话对象里 location 在 `location.directory`。
- [x] 1.2 实测 `permission.asked` 事件载荷顶层是否确实带 `location.directory`（用真实授权事件观察一次）—— 验证：日志中出现该字段值
  - 结果：**确认带**。实测输出：`permission.asked 顶层location={"directory":"/tmp/opencode"} dataKeys=id,sessionID,action,resources`。`data` 内**无**位置字段，必须从事件顶层取。
- [x] 1.3 若 1.1 受门控：确定回退策略（登记时拿不到位置则明确报错），并在 tasks 后续项标注；若 1.1 可行则按 design D2 实现兜底 —— 验证：结论写入 design 的 Open Questions 或代码注释
  - 结果：1.1 可行 → **按 design D2 实现兜底**（优先事件载荷，缺失时 `ctx.session.get()` 查询）。无需启用"拿不到位置就报错"的降级策略。

## 2. 进程级实例注册表

- [x] 2.1 新建 `control/instance-registry.ts`：会合点 `globalThis.__opencodeNotifyInstances__`，`register(location, api)` / `unregister(location, api)`（校验归属） / `getByLocation(location)` / `list()`，`api` **只含 `replyPermission`** —— 验证：`npx tsc --noEmit` 通过，且模块头写明「只暴露最小接口，勿暴露 ctx」
  - 结果：新增 `control/instance-registry.ts`（`registerInstance`/`unregisterInstance`/`getInstanceByLocation`/`listInstanceLocations`/`__resetInstanceRegistryForTest`）。模块头明确警告「只暴露最小接口，勿暴露完整 ctx」并说明理由。`TSC=0`。
- [x] 2.2 单测覆盖：登记后可查、注销后不可查、**同名 location 后登记覆盖前者**、**旧实例注销不误删新登记**、未登记 location 返回 undefined —— 验证：新增冒烟脚本全绿
  - 结果：新增 `scripts/instance-registry-smoke.ts`，7 组 **15 断言全过**（另含多 location 互不干扰、list、调用不串台）。

## 3. 路由接入

- [x] 3.1 `index.ts` 在 `setup` 时 `register(location, { replyPermission })`，cleanup 时 `unregister` —— 验证：日志可见登记/注销，且多实例各登记自己的 location
  - 结果：`setup` 内 `registerInstance(location, selfCapability)`；cleanup 内 `unregisterInstance(location, selfCapability)`（归属校验）。新增启动日志打印当前登记表，便于诊断。
- [x] 3.2 `permission.asked` 分支把事件顶层的 `location.directory` 存入 `PendingItem.locationDirectory`（复用既有字段） —— 验证：单测或日志确认条目带上位置
  - 结果：`registerPending("permission", …, undefined, { locationDirectory: event.location?.directory })`（第 5 个参数 `options` 传 undefined，第 6 个 `formExtra` 传位置）。
- [x] 3.3 重写 `bridge.replyPermission`：优先用条目里的 `locationDirectory`（缺失时按 1.1 结论兜底）→ `getByLocation` → 调目标实例的 `replyPermission` —— 验证：目标实例被调用（日志含调用方 location 与目标 location）
  - 结果：`replyPermission` 改为 `resolveSessionLocation()`（优先事件 hint，缺失时 `ctx.session.get`，实测不受门控）→ `getInstanceByLocation(target)` → `cap.replyPermission(...)`。
- [x] 3.4 目标实例不存在时抛**专用错误**（携带"项目未打开"语义）；宿主已结算与其它失败保持可区分 —— 验证：三类错误各自可构造且类型不同
  - 结果：新增 `PermissionTargetNotOpenError`（含 `targetLocation`）与 `PermissionAlreadySettledError`；后者由宿主 `not found` 类错误转换而来（区分"已结算/陈旧引用"与"项目未打开"）。
- [x] 3.5 `control/types.ts` / `control/controller.ts`：`replyPermission` 入参透传 `locationDirectory`，并把新错误类型转成对应回执措辞（**令牌不消费**） —— 验证：`TSC` 通过且回执文案符合 spec 的"失败原因分化"
  - 结果：`OpencodeBridge.replyPermission` 增加 `locationDirectory?`；controller 的 approve/always/deny 分支透传 `item.locationDirectory`。错误措辞经既有 `callBridge` 的 `e.message` 传出，令牌不消费逻辑不变。`TSC=0`；六个冒烟全绿。

## 4. 端到端复现验证（核心）

- [x] 4.1 构造「活动实例 location ≠ 会话 location」的真实场景（如先在 A 目录建会话并发授权、再让 B 目录的实例成为活动实例）—— 验证：`plugin.log` 确认 owner 与 `PendingItem.locationDirectory` 不同
  - 结果：构造成功 —— 会话 location=`…/mycbdHub`，owner location=`…/opencode-notify`，两者不同（正是修复前必失败的组合）。通知经 Terminator 遮挡强制发出。
- [x] 4.2 从手机/命令通道应答该令牌，确认**成功**（修复前必失败）—— 验证：回执为「已允许/已拒绝 <令牌>」（无"失败"），且宿主请求被结算
  - 结果：**通过**。`approve oc-8e11-400adb` → 回执「**已允许 oc-8e11-400adb**」（无"失败"），宿主侧该权限请求 pending 清空（已结算）。修复前同场景回执为「已允许 … 失败（令牌未消费）：Permission request not found」。
- [x] 4.3 边界：**目标项目未打开**（会话属于一个没有实例的目录）时应答 → 回执说明"该项目未打开"，**令牌保留** —— 验证：回执文案 + 令牌仍可查
  - 结果：**改用单测覆盖**。原因：实测发现「建该目录的会话」这一动作本身就会让宿主加载该 location 的实例（登记表随即出现该目录），故无法用真实场景构造"有会话但无实例"。新增 `scripts/permission-routing-smoke.ts` 复刻 `bridge.replyPermission` 的决策链并对该分支断言：抛 `PermissionTargetNotOpenError`、携带目标 location、措辞含「未打开」「请先打开该项目」。令牌保留由既有「失败不消费」逻辑保证（controller 的 `if (err) return …（令牌未消费）`）。
- [x] 4.4 边界：宿主已结算（应答前先在电脑上处理掉）→ 回执说明"已被处理或已取消"，令牌保留 —— 验证：回执文案
  - 结果：由 `permission-routing-smoke.ts` 第 2 组覆盖：宿主报 `not found` 时转成 `PermissionAlreadySettledError`，措辞「该请求已被处理或已取消」，且不把原始的 `Permission request not found` 作为用户可见主措辞。另第 3 组验证**其它错误不被误判**为已结算。

## 5. 回归

- [x] 5.1 `npx tsc --noEmit` 通过；五个既有冒烟（`events-route` / `control-protocol` / `control-stream` / `form-reply-bridge` / `control-credential-sharing`）全绿 —— 验证：命令输出
  - 结果：`TSC=0`；**七个**冒烟全绿（五个既有 + 新增 `instance-registry`(15) + `permission-routing`(15)）。
- [x] 5.2 跨进程隔离回归：另起独立 server 进程，确认令牌仍互不受理、无回执串答 —— 验证：两进程实例前缀不同且互不响应
  - 结果：**通过**。`run --standalone` 独立进程：`控制状态: 已建立 实例=9230`，其登记表 `["/tmp/opencode/proc2"]` **仅含自己**；主进程为 `实例=8e11`。三进程前缀（8505/8e11/9230）互不相同，**实例注册表也按进程隔离**（`globalThis` 天然边界），故不会跨进程路由应答。
- [x] 5.3 热重载回归：热重载后路由仍正确（新实例覆盖登记、旧登记不残留）—— 验证：登记表内容与应答结果
  - 结果：两次热重载共 12 条「实例已登记」日志，登记表随注册累积且**无重复残留**（每 location 一条）；`unregister` 的归属校验由 `instance-registry-smoke` 第 4 组覆盖；4.2 的端到端应答发生在热重载后的实例上并成功。

## 6. 文档同步

- [x] 6.1 `AGENTS.md` 补一条：**`permission.reply` 受实例 location 门控**，故应答必须路由到会话所属 location 的实例（含会合点键名与"只暴露最小接口"约束）—— 验证：与代码一致
  - 结果：`AGENTS.md` 新增完整条目（门控事实 / 实例注册表与最小接口约束 / 路由依据与事后兜底 / 三类失败分化 / 与 form 的机制对比 / 跨进程边界）；冒烟清单加 `instance-registry-smoke` 与 `permission-routing-smoke`；架构图补 `runtime-state.ts`、`instance-registry.ts` 与路由说明。
- [x] 6.2 `doc/v2-plugin-form-mechanism.md` 补一节：permission 与 form 的**定位机制差异**（前者按实例 location 门控、后者按 formID 在客户端侧），并记录本次实测证据（7 实例对照 / API vs 插件 ctx）—— 验证：文档含该结论与证据
  - 结果：新增 **8.9 节**（对照表 + 三条实测证据 + 事件载荷的坑：位置在 `permission.asked` 顶层，`data` 内没有）。
- [x] 6.3 修正文档里此前**不准确**的表述：先前写的"权限调用是 server 级、同进程任一实例都能应答"已被实测推翻 —— 验证：全局检索无该表述残留
  - 结果：该论断在 **8.7 节正文**（"同进程内所有实例共享同一个宿主 ctx（`permission.reply` … 调用都不带 location）"）—— 已改写并**加显式警示块**说明"前半句对、后半句错"及其导致的后续 change。注：同一论断也存在于**已归档**的 `archive/2026-09-29-share-control-state-process-wide/design.md`，归档文档是历史记录，**有意不改写**（保留当时的判断原貌），纠正由活跃文档承担。
