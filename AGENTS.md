# AGENTS.md

opencode 通知插件（TypeScript，运行于 Bun）。监听 opencode 会话事件，通过多渠道推送通知。

## 命令

- 类型检查（唯一的验证手段，无测试/lint/build 脚本）：`npx tsc --noEmit`（已含 `scripts/**/*.ts`）
- CLI 诊断（bin 指向 cli.ts）：`bun cli.ts check` / `bun cli.ts test [channel]` / `bun cli.ts log [lines]` / `bun cli.ts info`
- 本地冒烟（无需网络/opencode）：
  - `bun scripts/control-stream-smoke.ts` — 流式 provider（收消息/断线补漏/400重置/看门狗/401熔断/bot_tag 过滤）
  - `bun scripts/control-protocol-smoke.ts` — 协议层（数字协议/配置合并/按钮编排/sessions）
  - `bun scripts/events-route-smoke.ts` — **事件映射**（`route()` 对 V2 各事件的输出 + interrupted reason 过滤）
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
- **opencode 2.x 提问 = 权限闸 + form，无 question 事件**：宿主 `question` 工具（`id: opencode.tool.question`）先 `Permission.assert({action:"question"})`，通过后 `form.ask({title:"Questions", fields:[{key:"q0"},{key:"q1"}…]})`，答案按 `form.answer["q0"]` 读取（`multiple:true` 时值是 `string[]`）。V1 的 `question.asked/replied/rejected` 三个事件在 2.x **已完全不存在**，`pending.kind` 的 `"question"` 随之改名为 `"form"`。
- **⚠️ 2.x 插件 ctx 没有 form 域 → 提问无法从手机应答（已知能力缺口，用户已拍板保留通知+按钮）**：服务端有 `session.form.reply` 端点（TUI 在用），但宿主构造 ctx 是**白名单对象字面量**，`session` 域只有 `hook/create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/context`；`ctx.rpc` 只能调插件自注册 RPC，不是逃生口。因此 `index.ts` 的 `bridge.replyForm` 是**显式抛错**（不静默），点按后回执写明「opencode 2.x 插件 ctx 未暴露表单应答接口，请回电脑处理」，且**令牌不消费**（可重试）。将来 opencode 暴露 form 后，把 `replyForm` 换成 `ctx.session.form.reply` 即可，`control/` 层无需改动（`OpencodeBridge.replyForm` 签名即 `SessionFormReplyInput`）。变通：把 opencode 配置里 `question` 权限设为 `ask`，提问改走权限通道，可用 `approve` 应答。
- **远程控制经 `OpencodeBridge` 窄接口调宿主**（不再自建 SDK client）：`index.ts` 用 ctx 实现 `replyPermission`/`replyForm`/`prompt`/`interrupt` 四个方法注入 `ControlController`，`control/` 层不直接依赖 opencode 类型包。V1 时代"从注入 client 提取 fetch/headers 自建 v2 client（`buildV2Client`）"那套**已删除**（V2 ctx 直接给域，也不再有 `_input.serverUrl` 死地址问题）。
- **opencode V2 插件 API 约定**（`@opencode/plugin@2.x`）：入口是 `export default Plugin.define({ id, async setup(ctx) { … return cleanup } })`，`Cleanup = () => Promise<void> | void`；事件订阅用 `ctx.event.subscribe({ signal })` 返回 `AsyncIterable<Event>`，cleanup 里 `AbortController.abort()` 退出循环。**V2 把事件的 `properties` 统一改名为 `data`**（`events.ts` 的 `V2Event` 就是这个形状）。`ctx.permission.reply` 增了必填 `sessionID`、`reply` 改名为 `decision`（`once`/`always`/`reject`）；`session.abort` 改名为 `session.interrupt`；`session.prompt` 的 `parts` 数组改为扁平 `text`。**已消失的 V1 事件**：`message.part.updated`、`message.updated`、`question.*`、`session.updated`、`command.executed`、`session.error`、`permission.updated`。助手输出采集换源为 `session.text.delta`（**增量** `data.delta`，按 `assistantMessageID` 分桶，`session-tracker.appendAssistantText` 本身就是追加式，无需改）；用户输入采集换源为 `session.inbox.enqueued`（`data.item.type==="user"` → `data.item.payload.text`）；`session.updated` 拆成 `session.created`（**扁平**载荷，`data.parentID`/`data.title`，不再是 `data.info.*`）与 `session.renamed`；`run_failed`/`run_cancelled` 改用原生 `session.execution.failed`（`data.error.message`）/ `session.execution.interrupted`（`data.reason` ∈ user/shutdown/superseded/inactivity，**只 `user` 通知**，见上）。
- **一次性令牌格式为 `oc-<实例4位>-<随机6位>`，跨模块耦合**：`control/tokens.ts`（生成/正则）→ `control/pending.ts`（注册表：permission/form 一次性消费，**session 型 TTL 内可复用**）→ `control/parser.ts`（凭证强制语法，见下）→ `control/controller.ts`（凭证门卫：无归属/无效一律静默）。改令牌格式必须同步这 4 处。
- **`PendingRegistry.add()` 是幂等的**（同 `requestID` 复用既有令牌、只刷标题/选项/TTL）——opencode 会对同一事件连发多次，若轮换令牌，首条通知发给用户的令牌会立刻失效（真机 bug，commit `b9ad788`）。form 的 `answerKey`/`optionValues` 也在这条幂等分支里同步刷新，改动时勿漏。
- **凭证强制协议（用户明确要求，勿回退）**：所有命令必须携带令牌（`approve <令牌>` / `answer <令牌> <文本>` / `select <令牌> <数字>` / `say <令牌> <文本>` / `stop <令牌>` / `status <令牌>`；无动词简写已废除——所有命令必须有明确动词）。**无令牌 / 令牌无效 / 令牌异主 / 已消费 / 过期 → 完全静默**（不执行、不回执，仅日志）；`execute` 对 kind 不匹配的动作返回 null（静默）。`status` 验证不消费；完成类通知注册 `session` 型凭证（TTL 内可反复 say/stop）。会话码 `sc-xxxx` 已退役为**纯展示**（`sessions.ts`），不再受理任何回复。
- **执行成功才消费令牌**：`approve/always/deny/answer/select` 统一走 `callBridge()`，失败时**保留令牌**（TTL 内可重试）并在回执写明原因（含 `replyForm` 必然失败的情况）；成功才 `removeByCode`。勿改成"失败也消费"。
- **多实例/多机安全**：令牌含实例前缀 → 异主命令"查无此证"静默；这是砍掉裸数字/裸 say 换来的安全性，勿以"便捷"为由回退。
- **多进程隔离**：每个 opencode 进程在 `ControlController` 构造时生成随机实例前缀（`newInstanceId()`）。所有进程读同一条 ntfy/Gotify 队列，但只有令牌前缀匹配的进程执行该命令；不匹配则静默忽略（**不发回执**，避免噪音）。
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
- 不要删除/改动仓库根目录的 `config.json`（那是本仓库的 opencode agent 模型配置，已被 gitignore，非插件配置）。
- 插件配置是 YAML，模板见 `opencode-notify.yaml.example`，运行时配置在 `~/.config/opencode/opencode-notify.yaml`。优先级：YAML > plugin options > 默认值。
- `config.ts` 里 `resolveConfig/mergeConfig/loadYamlConfig` 的合并逻辑是配置行为的核心。

## 架构速览

```
index.ts (plugin 入口) → events.ts route() → message.ts enrich/format
       ↓
dispatcher.ts (即时) + delayed-dispatcher.ts (远程延迟)
       ↓
senders/ 各渠道：system(跨平台原生) / screen-flash(X11跑马灯) / wechat-work / feishu / ntfy(带按钮) / gotify / custom-webhook(命名多配置)

control/ (手机 → 插件 → opencode 应答，仅出站连接；配置在 channels.*.reply)
  controller.ts (命令执行 + 令牌/会话码隔离 + 按钮编排 + 最近通知会话)
    ↑ 经 OpencodeBridge 调用宿主（index.ts 用 ctx 实现并注入，control/ 不依赖 opencode 类型包）
    ├─ pending.ts (一次性令牌注册表，add() 幂等) / tokens.ts (令牌生成与格式) / sessions.ts (会话码 + 最近会话)
    ├─ parser.ts (命令解析：数字→choose / 动词 / 无动词提示)
    └─ ntfy-common.ts (tags/认证头/URL/回执) + ntfy-stream.ts (默认长连接) / ntfy.ts (poll 兜底) / gotify.ts (轮询；与 senders/ 同名文件不同：这里读命令，那里发通知)
```

- `session-tracker.ts`：会话活跃/空闲追踪、用户输入与助手回复累积，驱动抑制与延迟推送取消。
- `terminator-detect.ts`：Terminator 子屏遮挡检测（需 `TERMINATOR_UUID` 环境变量，检测结果 5s TTL 缓存防高频 `execSync`）。
- `store.ts`：文件持久化去重（1s 防抖写盘）。
- 所有对外 HTTP 请求（wechat-work / feishu / custom-webhook / cli test）均已加 AbortController 超时；平台发送器用的 `execSync` 多数带 `timeout`。

## 说明

- 主要在 Ubuntu 24.04 (X11) 测试；`screen-flash` 仅 Linux X11（Python GTK3）。改平台相关代码注意其余平台（`senders/system/{darwin,win32}.ts`）。
- 文档在 `doc/`（features / install / notify-format-test）。
- 仓库根目录的 `plan.md` / `task_plan.md` / `progress.md` / `findings.md` 是会话规划产物（planning-with-files），非项目文档，不要当作参考资料或打包进发布。