# AGENTS.md

opencode 通知插件（TypeScript，运行于 Bun）。监听 opencode 会话事件，通过多渠道推送通知。

## 命令

- 类型检查（唯一的验证手段，无测试/lint/build 脚本）：`npx tsc --noEmit`（已含 `scripts/**/*.ts`）
- CLI 诊断（bin 指向 cli.ts）：`bun cli.ts check` / `bun cli.ts test [channel]` / `bun cli.ts log [lines]` / `bun cli.ts info`
- 本地冒烟（无需网络/opencode）：
  - `bun scripts/control-stream-smoke.ts` — 流式 provider（收消息/断线补漏/400重置/看门狗/401熔断/bot_tag 过滤）
  - `bun scripts/control-protocol-smoke.ts` — 协议层（数字协议/配置合并/按钮编排/sessions）
- 真实 ntfy 集成（需运行时配置，会推手机通知）：
  - `bun scripts/ntfy-integration.ts tags|preview|copy|actions`（⚠️ token 通常按话题授权，只能用配置里的 `topic`，随机话题会 403）
- ⚠️ `test` 的渠道名取**配置键**：`system_message` / `wechat_work` / `feishu` / `custom_webhook`。帮助/报错里写的 `system` 实际匹配不到任何渠道（`cli.ts:195` 注册名是 `system_message`）。
- 运行时：`bun`。不要用 `node` 直接跑入口文件。
- 插件加载时自动写日志：`~/.opencode-notify/plugin.log`；去重状态文件 `~/.opencode-notify/state.json`。

## 关键约定（容易踩坑）

- **导入用 `.js` 后缀，但文件是 `.ts`**。`package.json` 声明 `"type": "module"`，全库 import 都是 `./x.js` 指向 `x.ts`（Bun 运行、`tsc` 用 `moduleResolution: bundler` 解析）。不要"修正"成 `.ts`。
- **"输出"字段长度 = 3 处共同决定**：`index.ts:90/93`（源头捕获 `slice(0, 1000)`）→ `session-tracker.ts`（`appendAssistantText`/`freezeAssistantSummary` 累积+冻结截断到 500）→ `message.ts` `enrich`（`shortTitle(assistantSummary, 500)` 最终截断；标题取用户输入前 16 字、正文"输入"行取前 80 字）。想改通知里的输出内容长度必须同步这 3 处；当前实际展示上限是 **500**（不是 index.ts 的 1000）。
- **`run_completed` 不在 `events.ts` 里生成**，由 `index.ts` 的会话状态机（`session.idle`/`session.status(idle)` + 子会话追踪）合成。改事件映射先看 `events.ts` 注释 + `index.ts`。
- **`question.asked` 在 `events.ts` 里也被映射成 `permission_required`**：需要区分权限与提问时，必须按原始 `type` 判断，不能只看 `msg.event`（`index.ts` 的待处理登记就这么做）。
- **远程控制用的是 v2 SDK 客户端**：`PluginInput.client` 本身是 v1 客户端（无 question API），所以 `control/controller.ts` 从 `@opencode-ai/sdk/v2/client` 自建 v2 客户端，走 `permission.reply` / `question.reply`。v1 与 v2 的方法命名不同（v1: `postSessionIdPermissionsPermissionId`、`session.prompt({path:{id}})`；v2: `permission.reply`、`session.prompt({sessionID})`），改控制代码时别看错版本。
  - **构造 v2 客户端必须复用注入 client 的 fetch**：`opencode` 直跑（非 server）时服务在同一进程内、**不监听任何 HTTP 端口**，此时 `_input.serverUrl` 恒为兜底值 `http://localhost:4096`（死地址），按它自建 client 会 fetch 失败并返回 `{error:{}}`（truthy）→ 回执带「(服务返回错误)」。opencode 注入的 v1 client 内部持有真正的通道：直跑时是**内存 fetch**（`Server.Default().app.fetch`），server 模式是带 `ServerAuth.headers()` 的网络 fetch。因此由 `controller.ts` 的 `buildV2Client()` 从注入 client 的 `_client.getConfig()` 提取 `fetch` / `headers` 再构造 v2 client（`headers` 需从 `Headers` 实例归一化为普通对象，否则 v2 内部 `{...headers}` 展开会丢认证头）。启动日志 `client=injected` 表示提取成功，`client=self` + 告警表示提取失败已降级。
- **一次性令牌格式为 `oc-<实例4位>-<随机6位>`，跨模块耦合**：`control/tokens.ts`（生成/正则）→ `control/pending.ts`（注册表：permission/question 一次性消费，**session 型 TTL 内可复用**）→ `control/parser.ts`（凭证强制语法，见下）→ `control/controller.ts`（凭证门卫：无归属/无效一律静默）。改令牌格式必须同步这 4 处。
- **凭证强制协议（用户明确要求，勿回退）**：所有命令必须携带令牌（`approve <令牌>` / `answer <令牌> <文本>` / `select <令牌> <数字>` / `say <令牌> <文本>` / `stop <令牌>` / `status <令牌>`；无动词简写已废除——所有命令必须有明确动词）。**无令牌 / 令牌无效 / 令牌异主 / 已消费 / 过期 → 完全静默**（不执行、不回执，仅日志）；`execute` 对 kind 不匹配的动作返回 null（静默）。`status` 验证不消费；完成类通知注册 `session` 型凭证（TTL 内可反复 say/stop）。会话码 `sc-xxxx` 已退役为**纯展示**（`sessions.ts`），不再受理任何回复。
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
    ├─ pending.ts (一次性令牌注册表) / tokens.ts (令牌生成与格式) / sessions.ts (会话码 + 最近会话)
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