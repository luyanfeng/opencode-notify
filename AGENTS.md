# AGENTS.md

opencode 通知插件（TypeScript，运行于 Bun）。监听 opencode 会话事件，通过多渠道推送通知。

## 命令

- 类型检查（唯一的验证手段，无测试/lint/build 脚本）：`npx tsc --noEmit`（已含 `scripts/**/*.ts`）
- CLI 诊断（bin 指向 cli.ts）：`bun cli.ts check` / `bun cli.ts test [channel]` / `bun cli.ts log [lines]` / `bun cli.ts info`
- 本地冒烟（无需网络/opencode）：
  - `bun scripts/control-stream-smoke.ts` — 流式 provider（收消息/断线补漏/400重置/看门狗/401熔断/bot_tag 过滤）
  - `bun scripts/control-protocol-smoke.ts` — 协议层（数字协议/配置合并/按钮编排/sessions）
  - `bun scripts/events-route-smoke.ts` — **事件映射**（`route()` 对 V2 各事件的输出 + interrupted reason 过滤）
  - `bun scripts/form-reply-bridge-smoke.ts` — **表单应答桥**（服务端侧：注册/成功确认/失败/超时/同 formID 复用/无等待者确认/dispose/派发失败）
  - `bun scripts/control-credential-sharing-smoke.ts` — **凭证共享**（进程级共享：owner 变更/热重载/跨进程隔离/配置指纹重建+迁移/裁剪/静默语义）
  - `bun scripts/instance-registry-smoke.ts` — **实例注册表**（登记/注销/同名覆盖/归属校验/多 location 隔离/不串台）
  - `bun scripts/permission-routing-smoke.ts` — **授权应答路由决策**（目标无实例→未打开/宿主 not found→已结算/其它错误不误判/路由不串台/hint 与兜底）
- 真实 ntfy 集成（需运行时配置，会推手机通知）：
  - `bun scripts/ntfy-integration.ts tags|preview|copy|actions`（⚠️ token 通常按话题授权，只能用配置里的 `topic`，随机话题会 403）
- ⚠️ `test` 的渠道名取**配置键**：`system_message` / `wechat_work` / `feishu` / `custom_webhook`。帮助/报错里写的 `system` 实际匹配不到任何渠道（`cli.ts:195` 注册名是 `system_message`）。
- 运行时：`bun`。不要用 `node` 直接跑入口文件。
- 插件加载时自动写日志：`~/.opencode-notify/plugin.log`；去重状态文件 `~/.opencode-notify/state.json`。

## 关键约定（容易踩坑）

- **导入用 `.js` 后缀，但文件是 `.ts`**。`package.json` 声明 `"type": "module"`，全库 import 都是 `./x.js` 指向 `x.ts`（Bun 运行、`tsc` 用 `moduleResolution: bundler` 解析）。不要"修正"成 `.ts`。
- **"输出"字段长度 = 2 处共同决定**：`session-tracker.ts`（`appendAssistantText` 按 `BUCKET_MAX_BYTES=3072` 累积+从头部截断、`freezeAssistantSummary` 冻结）→ `message.ts:130` `enrich`（`shortTitle(assistantSummary, 500)` 最终截断）。想改通知里的输出内容长度改 `message.ts:130` 即可；"输入"行另走用户输入侧（`index.ts:205` 源头 `slice(0, 1000)`，标题取前 16 字、正文取前 80 字）。
- **`run_completed` 不在 `events.ts` 里生成**，由 `index.ts` 的会话状态机（`session.idle`/`session.status(idle)` + 子会话追踪）合成。⚠️ V2 另有原生 `session.execution.succeeded`，**已考证并确认不能替代这套状态机**（勿再反复考证，直接维持现状）：① 宿主的 `SessionExecution`（`class Rd extends K()("@opencode/SessionExecution")`）**按 sessionID 独立结算**（`settled` 只 drain 该 sessionID 自己的 inbox），**不等子会话**；宿主自己的通知逻辑也印证这点 —— `Sr(t,p,"Session done", D?.parentID?"subagent_done":"done")`，即子会话各发各的 `succeeded`，只是换了个更安静的音效 + `notification:false`。而 `session.execution.succeeded` 恰恰**不含** `hasActiveChildren()` 提供的"等所有子会话跑完"语义。② `session.idle` 本就是由三个终态事件派生的（宿主 `case "session.execution.succeeded"/"failed"/"interrupted": v(sessionID,"idle")`），现有状态机已完整覆盖 `succeeded`。改事件映射先看 `events.ts` 注释 + `index.ts`。
- **`run_cancelled` 只对 `reason === "user"` 通知**（`events.ts` 的 `NOTIFIABLE_INTERRUPT_REASONS`），`shutdown`/`superseded`/`inactivity` 一律静默且**绝不降级成 `run_failed`**。依据：宿主的结算判定 `n0()` 里 `reason:"user"` 对应 `AbortError`（= V1 `MessageAbortedError` 口径），`shutdown` 来自 abort 信号（opencode 关闭/重载），而 `shutdown` 被宿主**两处特殊排除** —— SQL 层 `if (type===Interrupted && reason==="shutdown") return;`（不写 `idle_outcome`）、通知层走独立分支。要放宽只需改那个 Set。
- **`form.created`（提问）在 `events.ts` 里也被映射成 `permission_required`**：需要区分权限与提问时，必须按原始 `type` 判断，不能只看 `msg.event`（`index.ts` 的待处理登记就这么做）。⚠️ `form.created` 的会话 ID 在 `data.form.sessionID`，**不在** `data.sessionID`。
- **opencode 2.x 提问 = 权限闸 + form，无 question 事件**：宿主 `question` 工具（`ctx.tool.list()` 实测 `id` 就是 **`question`**，不是文档早先误写的 `opencode.tool.question`）先 `Permission.assert({action:"question"})`，通过后 `form.ask({title:"Questions", fields:[{key:"q0"},{key:"q1"}…]})`，答案按 `form.answer["q0"]` 读取（`multiple:true` 时值是 `string[]`）。V1 的 `question.asked/replied/rejected` 三个事件在 2.x **已完全不存在**，`pending.kind` 的 `"question"` 随之改名为 `"form"`。
- **✅ 2.x 提问（form）应答已打通：同包 `./tui` 入口 + RPC 回调确认（机制与实证见 `doc/v2-plugin-form-mechanism.md`）**：`form.reply` 不在服务端插件 ctx（`Context` 无 `form` 域、`SessionDomain` 的 `Pick` 未含、运行时白名单字面量 `adapter.js:417-432`），而在 **TUI/CLI 插件上下文**（`@opencode/plugin/tui` → `context.data.session.form.reply(input, location)`，入参 `{sessionID, formID, answer}`）。实现：
  - **两个入口**：`index.ts`（服务端，包名 `.`）+ `tui.ts`（终端，`exports["./tui"]`）。暴露 `./tui` 的包由 CLI **自动加载**（官方《CLI plugins》：*"loaded automatically by the CLI"*，**无需**在 `cli.json` 登记）——已实测：CLI 侧插件对账 `plugins=13→14`。
  - **契约**：`form-reply-rpc.ts` 定义 `events.request`（服务端→TUI）与 `methods.confirm`/`methods.ping`（TUI→服务端），两端**共用同一 definition 对象**（各写一份会在运行时静默失配）。
  - **⚠️ RPC 注册按 location 作用域（实测踩坑）**：只由单个实例注册时，位于其它目录的 TUI 调 `client.rpc(D)` 会得到 `rpc.unavailable`。因此**每个实例都要注册自己那份**（放在单例 `activate` 之外）；而**等待表必须放 `globalThis`**（`form-reply-bridge.ts` 的 `__opencodeNotifyFormReplyWaiters__`），因为 TUI 的 `confirm` 会打到它自己 location 的实例，可能是任意一个。
  - **结果判定**：`FormReplyBridge`（`form-reply-bridge.ts`）派发后**等 `confirm`**（超时 `form_reply_timeout_ms`，默认 5000）：`ok:true`→成功（消费令牌）；`ok:false`→抛 `FormReplyFailedError`（回执原因、保留令牌）；超时→抛 `FormReplyTimeoutError`（回执「当前没有终端客户端在运行，请回电脑处理」、保留令牌）。**必须等确认**：RPC 事件即发即忘且订阅是实时连接，不等就无法区分「没人处理」与「已处理」。
  - **多终端竞争（design D2）**：请求带 `locationDirectory`（来源 `form.created` 事件顶层的 `location.directory`，经 `PendingItem.locationDirectory` 透传），TUI 按「位置匹配（主）→ 会话持有（次，`data.session.sync` 后 `get`）→ 不匹配即静默」过滤；兜底为先到先得 + 已结算静默（`FormAlreadySettledError` 的 `_tag`）。实测 3 终端在线仅归属方投递。
  - **⚠️ 事件会重放**：同一 `events.request` 载荷会被订阅方反复收到，所以消费方必须幂等（`inFlight` 集合 + 已结算静默）。
  - **前提与边界**：应答由**终端侧**执行 —— 没有终端客户端运行时无法从手机应答（超时如实告知）；纯后台 `opencode run` 无终端，其无头提问被宿主自行 dismiss，插件管不到。
  - **Effect 错误渲染**：`String(e)` 会退化成 `[object Object]`，取错误信息须用 `tui.ts` 的 `describeError`（读 `_tag`/`message`/JSON）。
  - 失败路径一律**不静默**：回执写明原因且令牌保留可重试（既有「执行成功才消费令牌」约定不变，`control/` 层零改动）。
- **远程控制经 `OpencodeBridge` 窄接口调宿主**（不再自建 SDK client）：`index.ts` 用 ctx 实现 `replyPermission`/`replyForm`/`prompt`/`interrupt` 四个方法注入 `ControlController`，`control/` 层不直接依赖 opencode 类型包。V1 时代"从注入 client 提取 fetch/headers 自建 v2 client（`buildV2Client`）"那套**已删除**（V2 ctx 直接给域，也不再有 `_input.serverUrl` 死地址问题）。
- **⚠️ `permission.reply` 受「实例 location」门控 → 必须路由到会话所属 location 的实例**（change `route-permission-reply-by-location`）：宿主只接受「实例 location == 会话所属目录」的调用，否则报 `Permission request not found`。而单例选出的 owner 可能属于任意 location（打开别的项目、`run --standalone` 都会改变），故**不能**用「当前活动实例」直接应答。
  - 机制：新增进程级**实例注册表** `control/instance-registry.ts`（会合点 `globalThis.__opencodeNotifyInstances__`）。每个实例 `setup` 时登记自己的**最小能力**（**只有 `replyPermission`，勿暴露完整 ctx** —— 暴露 ctx 等于让任意实例对任意 location 调用全部宿主能力，破坏 location 隔离），cleanup 时 `unregister`（**归属校验**，避免旧实例卸载误删新登记）。owner 收到命令后：解析会话 location → `getInstanceByLocation` → 调目标实例的 `replyPermission`。
  - 路由依据：`PendingItem.locationDirectory`，来源是 **`permission.asked` 事件顶层**的 `location.directory`（⚠️ `data` 内**没有**位置字段）；缺失时用 `ctx.session.get({sessionID})` 兜底 —— 实测 `session.get` **不受** location 门控，可读其它目录的会话。
  - 失败原因分化（勿合并措辞）：目标无实例 → `PermissionTargetNotOpenError`「该会话所在项目未打开终端，请先打开该项目后重试」；宿主报 not found → `PermissionAlreadySettledError`「该请求已被处理或已取消」；其余原样抛出。**三者都保留令牌**（既有"成功才消费"逻辑）。
  - 与 form 的对比（**机制相反，勿混**）：form 按 `formID` 在**客户端侧**定位、**不受** location 门控；permission 按**实例 location** 门控、须服务端路由。详表见 `doc/v2-plugin-form-mechanism.md` 第 8.9 节。
  - 边界：跨进程仍隔离（注册表在 `globalThis`，每进程独立）；实测独立进程的登记表**只含自己**。
- **opencode V2 插件 API 约定**（`@opencode/plugin@2.x`）：入口是 `export default Plugin.define({ id, async setup(ctx) { … return cleanup } })`，`Cleanup = () => Promise<void> | void`；事件订阅用 `ctx.event.subscribe({ signal })` 返回 `AsyncIterable<Event>`，cleanup 里 `AbortController.abort()` 退出循环。**V2 把事件的 `properties` 统一改名为 `data`**（`events.ts` 的 `V2Event` 就是这个形状）。`ctx.permission.reply` 增了必填 `sessionID`、`reply` 改名为 `decision`（`once`/`always`/`reject`）；`session.abort` 改名为 `session.interrupt`；`session.prompt` 的 `parts` 数组改为扁平 `text`。**已消失的 V1 事件**：`message.part.updated`、`message.updated`、`question.*`、`session.updated`、`command.executed`、`session.error`、`permission.updated`。助手输出采集换源为 `session.text.delta`（**增量** `data.delta`，按 `assistantMessageID` 分桶，`session-tracker.appendAssistantText` 本身就是追加式，无需改）；用户输入采集换源为 `session.inbox.enqueued`（`data.item.type==="user"` → `data.item.payload.text`）；`session.updated` 拆成 `session.created`（**扁平**载荷，`data.parentID`/`data.title`，不再是 `data.info.*`）与 `session.renamed`；`run_failed`/`run_cancelled` 改用原生 `session.execution.failed`（`data.error.message`）/ `session.execution.interrupted`（`data.reason` ∈ user/shutdown/superseded/inactivity，**只 `user` 通知**，见上）。
- **一次性令牌格式为 `oc-<实例4位>-<随机6位>`，跨模块耦合**：`control/tokens.ts`（生成/正则）→ `control/runtime-state.ts`（**进程级**实例前缀来源）→ `control/pending.ts`（注册表：permission/form 一次性消费，**session 型 TTL 内可复用**）→ `control/parser.ts`（凭证强制语法，见下）→ `control/controller.ts`（凭证门卫：无归属/无效一律静默）。改令牌格式必须同步这 5 处。
- **`PendingRegistry.add()` 是幂等的**（同 `requestID` 复用既有令牌、只刷标题/选项/TTL）——opencode 会对同一事件连发多次，若轮换令牌，首条通知发给用户的令牌会立刻失效（真机 bug，commit `b9ad788`）。form 的 `answerKey`/`optionValues` 也在这条幂等分支里同步刷新，改动时勿漏。
- **凭证强制协议（用户明确要求，勿回退）**：所有命令必须携带令牌（`approve <令牌>` / `answer <令牌> <文本>` / `select <令牌> <数字>` / `say <令牌> <文本>` / `stop <令牌>` / `status <令牌>`；无动词简写已废除——所有命令必须有明确动词）。**无令牌 / 令牌无效 / 令牌异主 / 已消费 / 过期 → 完全静默**（不执行、不回执，仅日志）；`execute` 对 kind 不匹配的动作返回 null（静默）。`status` 验证不消费；完成类通知注册 `session` 型凭证（TTL 内可反复 say/stop）。会话码 `sc-xxxx` 已退役为**纯展示**（`sessions.ts`），不再受理任何回复。
- **执行成功才消费令牌**：`approve/always/deny/answer/select` 统一走 `callBridge()`，失败时**保留令牌**（TTL 内可重试）并在回执写明原因（超时/无终端、宿主已结算等）；成功才 `removeByCode`。勿改成"失败也消费"。
- **多实例/多机安全**：令牌含实例前缀 → 异主命令"查无此证"静默；这是砍掉裸数字/裸 say 换来的安全性，勿以"便捷"为由回退。
- **⚠️ 隔离粒度是「server 进程」而不是「插件实例」**：实例前缀与待处理注册表**都取自进程级共享状态**（`control/runtime-state.ts`，会合点 `globalThis.__opencodeNotifyControlState__`）。**同一 server 进程内所有 location 实例共用同一前缀与同一份注册表** —— 因为宿主每个 location 各加载一份实例、单例只在其中选一个 owner，若前缀/注册表是实例私有的，owner 一变（打开新项目、热重载）先前发出的令牌就全部作废且被**静默丢弃**（真机 bug，change `share-control-state-process-wide`）。共享**不影响跨进程/跨机隔离**：`globalThis` 每进程独立，故多个 `opencode server`（`serve --port` / `run --standalone`）之间前缀天然不同（实测：主进程 `8e11`，独立进程 `8505`）。**写侧约束：只有 owner 会写注册表**（`index.ts` 的 `finishNotification` 有 `isActive()` 闸门，在所有 `registerPending` 之前），命令通道也只有 owner 在跑 —— 共享注册表不会让"本应隔离的两份控制逻辑"互相干扰；改这里前先确认该约束仍成立。
- **注册表配置变更靠指纹重建**：`getControlState()` 以 `token_ttl_ms`+`max_pending` 为指纹；指纹变化才按新参数重建，并**先快照再恢复**（不丢已发出的令牌），最后由 `PendingRegistry.restore()` **显式裁剪一次**（`add()` 的裁剪只在 push 后触发，迁移不走 `add`，故 max 调小必须显式裁）。因会合点在 `globalThis` 跨热重载存活，指纹未变时直接复用既有注册表。⚠️ 已知语义：`token_ttl_ms` 变更会影响**存量**条目的过期判定（变大可能让原本过期的"复活"，变小则立即过期）。
- **ntfy 通知按钮**：`senders/ntfy.ts`（`NtfyNotifySender`）把 `Message.controlButtons` 渲染成 ntfy `Actions` 头，按钮的 `http` 动作 POST 回 `reply.command_topic` 形成闭环。通知 `topic` 必须 ≠ `reply.command_topic`（`config.ts` `resolveReplyConfig` 有回环校验，相同则禁用按钮并告警）。Actions 值含 `,;"'` 时必须加引号。
- **远程控制配置挂在渠道下**：`channels.ntfy.reply` / `channels.gotify.reply`（无顶层 `control` 块）。`config.ts` 的 `resolveReplyConfig` 产出 `ReplyConfig`；`index.ts` 取 `cfg.channels.ntfy?.reply ?? cfg.channels.gotify?.reply`（二者互斥，只启动一个命令通道）。
- **ntfy 命令读取默认流式**：`reply.transport` 默认 `stream`（`control/ntfy-stream.ts` 长连接订阅 `GET .../json`，keepalive 45s、看门狗 120s、断线带 `since=<最后message id>` 重连、400 则重置游标、消息去重）；`transport: poll` 走 `control/ntfy.ts` 的 `NtfyPollProvider`（原轮询实现，保留兜底）。工厂在 `controller.ts` 的 `createProvider()`。两者共用 `control/ntfy-common.ts`（认证头/URL/回执发布）。**游标只按 `event=message` 的 id 推进**（`open`/`keepalive` 的 id 不在缓存，用作 `since` 会触发整段缓存重放）。
- **ntfy 默认合并单话题**：`reply.command_topic` **省略** → `commandTopic = topic`（`merged=true`），插件订阅自己发布的话题。发布的通知/回执都带 `tags:[reply.bot_tag]`（默认 `opencode`），provider 在**解析命令之前**按 `isBotMessage()` 过滤自身消息防回环（`ntfy-stream.ts` / `ntfy.ts`）。填写 `command_topic` → 分离双话题（旧行为），此时 `copyButton` 强制 false。
- **通知按钮编排（ntfy 服务端硬限每条 ≤3 个 action，`action.go:actionsMax=3`，改需自编译服务端，勿依赖 >3）**：权限=[允许][始终允许][拒绝]（http）；提问 ≤2 选项=[选项][选项][复制]；提问 ≥3 选项或 0 选项=[复制]（≥3 时正文列 `1. …` 供数字回复）；完成类=[复制续接命令][状态]。`ControlButton` 用 `body`（http）或 `value`（copy）二选一，渲染在 `senders/ntfy.ts:buildActions`。`copy` 的 value 如 `say sc-xxxx `（**带尾空格**，粘贴后直接补正文）。
- **显式回复协议（不猜）**：`parser.ts` 整条纯数字 → `choose`（选「唯一待处理提问」的选项，由 `controller.execute` 校验唯一性/越界/无选项）；动词开头按动词；**其它无动词文本解析失败** → `controller.onRawMessage` 回执语法提示（用户明确要求不静默）。无 ref 的 `say`/`stop` 定位到 `sessions.mostRecent()`（`noteNotified` 在通知发出时 touch）。
- **多进程隔离扩展**：除令牌按实例前缀过滤外，**会话码不属本进程时静默忽略**（`controller.onRawMessage` 检查 `sessionCodes.sessionFor` 为空即丢弃，不发回执）。由于合并单话题的裸文本/纯数字无令牌，多进程下可能各进程重复响应（已知限制，单进程无此问题）。
- **`custom_webhook` 是命名多配置**：形如 `custom_webhook: { my_slack: { mode, url, ... } }`；旧的单对象写法仍兼容（`normalizeCustomWebhooks` 归一到 key `custom_webhook`）。`buildSenders` 遍历注册，渠道名即用户自定义名。
- **子会话（background task）只通知 `permission_required`**：其余事件（含 `run_completed`/`run_failed`/`run_cancelled`）一律静默（`index.ts:220-224`，commit `b4e4183` 改前曾是"仅 fail 仍通知"）。
- **事件路由**：`events.ts:route()` 把 opencode 事件映射为内部 `Message`；`message.ts` 负责格式化（`formatBody`/`enrich`）；`index.ts` 组装发送器和会话追踪。
- **⚠️ 每 location 一份插件实例 → 必须走 `process-singleton.ts` 收敛**：opencode 2.x **每个 location（项目目录）各加载一份插件实例**，而 `ctx.event.subscribe` 收到的是 server 级公共事件流（**没有 location 维度**），所以同一个事件会被 N 份实例各处理一次 —— 一次事件发 N 条重复通知，外加 N 条 ntfy 长连接、N 套延迟推送。这是宿主设计不是 bug。收敛靠 `process-singleton.ts`：会合点是 `globalThis.__opencodeNotifyRuntime__`（**模块级状态不可用** —— 实测同一 entrypoint 在同进程被求值为 N 份独立模块；`ctx.storage` 也按 location 隔离）。**只有活动实例**订阅事件 + 发通知 + 跑命令通道，其余实例完全空闲。选举规则是**最新注册者直接夺权**，不是"首个上位 + teardown 交接"——后者依赖宿主每次重载都调 cleanup，有例外时第一个实例会永远占着 owner 导致改配置/改代码不生效。改动这里务必同步 `index.ts` 的 `activate`/`deactivate` 与 `finishNotification` 开头的 `isActive()` 闸门。日志判据：`单例: 本实例已上位` / `已让位` / `插件卸载`。
- **⚠️ 跨进程去重靠 `store.ts` 的 O_EXCL 按键占位**：单例只覆盖「一个 server 进程」。同时跑多个 `opencode server` 时各进程 `lastSent` 互不可见，同一通知仍会发多遍。做法是每个去重 key 建一个占位文件，`open(path,"wx")`（`O_CREAT|O_EXCL`，OS 级原子）抢发送权，拿到 `EEXIST` 即判重复；占位 mtime 即窗口起点，过期可被后来者删除抢占。**三个坑**：① 占位文件必须写 owner token，`clearReservation` 释放前校验归属，否则会误删已被别人抢占的占位、毁掉其去重保证；② 占位创建失败（目录不可写等）**记 error 后照常发送** —— 去重是防噪音优化，送达是主功能，宁可重复也不能不响；③ 占位文件保留 24h，`pruneClaims()` 在 `FileStore` 构造时懒清理。
- 不要删除/改动仓库根目录的 `config.json`（那是本仓库的 opencode agent 模型配置，已被 gitignore，非插件配置）。
- 插件配置是 YAML，模板见 `opencode-notify.yaml.example`，运行时配置在 `~/.config/opencode/opencode-notify.yaml`。优先级：YAML > plugin options > 默认值。
- **⚠️ 部署坑：opencode 2.x 的 `plugin` 数组不再接受 `file://` 单文件，必须写目录**。V1 时代的 `"file:///…/opencode-notify/index.ts"` 在 2.x 下**只会打一条 `configured plugin path must be a directory` 的 WARN 然后静默跳过 —— 插件根本不加载，所有通知/远程控制全部失效，且没有任何报错**。正确写法是去掉文件名、指向插件目录（宿主按 `package.json` 的 `main`/`exports` 解析入口，本仓库两者都已具备）。判定方法：`~/.local/share/opencode/log/opencode.log` 里搜 `msg="loading plugin" id=…opencode-notify` —— **没有这行就是没加载**（WARN 不能作为判据，`~/.config/opencode/plugins/*.ts` 里的文件同样会 WARN 但通过自动扫描正常加载）。改完必须重启 `opencode serve` 才生效（插件只在 server 启动时加载）。
- `config.ts` 里 `resolveConfig/mergeConfig/loadYamlConfig` 的合并逻辑是配置行为的核心。

## 架构速览

```
process-singleton.ts (进程级单例：每 location 一实例 → 只留最新注册者 active)

index.ts (服务端插件入口, exports ".") → events.ts route() → message.ts enrich/format
       ↓
dispatcher.ts (即时) + delayed-dispatcher.ts (远程延迟)
       ↓
senders/ 各渠道：system(跨平台原生) / screen-flash(X11跑马灯) / wechat-work / feishu / ntfy(带按钮) / gotify / custom-webhook(命名多配置)

control/ (手机 → 插件 → opencode 应答，仅出站连接；配置在 channels.*.reply)
  controller.ts (命令执行 + 令牌/会话码隔离 + 按钮编排 + 最近通知会话)
    ↑ 经 OpencodeBridge 调用宿主（index.ts 用 ctx 实现并注入，control/ 不依赖 opencode 类型包）
    ├─ pending.ts (一次性令牌注册表，add() 幂等) / tokens.ts (令牌生成与格式) / sessions.ts (会话码 + 最近会话)
    ├─ parser.ts (命令解析：数字→choose / 动词 / 无动词提示)
    ├─ runtime-state.ts (进程级：实例前缀 + 注册表 + 配置指纹)
    ├─ instance-registry.ts (进程级：location → 实例的 replyPermission，供授权应答按 location 路由)
    └─ ntfy-common.ts (tags/认证头/URL/回执) + ntfy-stream.ts (默认长连接) / ntfy.ts (poll 兜底) / gotify.ts (轮询；与 senders/ 同名文件不同：这里读命令，那里发通知)

⚠️ permission 应答按 location 路由：宿主门控「实例 location == 会话所属目录」，
   故 owner 经 instance-registry 找目标 location 的实例代答（form 则相反，见 tui.ts）

tui.ts (TUI/CLI 插件入口, exports "./tui"，由 CLI 自动加载，跑在终端进程)
  ↑ 服务端 form 应答的唯一通道：form-reply-rpc.ts (契约, 两端共用) + form-reply-bridge.ts (服务端侧派发/等确认)
    手机应答提问：ntfy → index.ts → RPC events.request → tui.ts → form.reply → methods.confirm → index.ts
```

- `session-tracker.ts`：会话活跃/空闲追踪、用户输入与助手回复累积，驱动抑制与延迟推送取消。
- `terminator-detect.ts`：Terminator 子屏遮挡检测（需 `TERMINATOR_UUID` 环境变量，检测结果 5s TTL 缓存防高频 `execSync`）。
- `store.ts`：文件持久化去重（1s 防抖写盘）+ 跨进程 O_EXCL 按键占位（见下）。
- 所有对外 HTTP 请求（wechat-work / feishu / custom-webhook / cli test）均已加 AbortController 超时；平台发送器用的 `execSync` 多数带 `timeout`。

## 说明

- 主要在 Ubuntu 24.04 (X11) 测试；`screen-flash` 仅 Linux X11（Python GTK3）。改平台相关代码注意其余平台（`senders/system/{darwin,win32}.ts`）。
- 文档在 `doc/`（features / install / notify-format-test / **v2-plugin-form-mechanism**（2.x form 应答机制与实证，改 form 相关代码前先读））。
- 仓库根目录的 `plan.md` / `task_plan.md` / `progress.md` / `findings.md` 是会话规划产物（planning-with-files），非项目文档，不要当作参考资料或打包进发布。