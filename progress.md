# Progress Log

## Session: 2026-06-24

### Phase 1: 高优先级安全与崩溃修复
- **Status:** complete
- **Started:** 2026-06-24
- **Completed:** 2026-06-24
- Actions taken:
  - 修复 `buildSenders` 4 处非空断言 `!` → 替换为 `?? { mode: "none" }` 默认值
  - 修复 `custom-webhook.ts` `fetch` 无超时 → 添加 AbortController 10s
  - 修复 `feishu.ts` `fetch` 无超时 → 添加 AbortController 10s
  - 修复 `wechat-work.ts` `fetch` 无超时 → 添加 AbortController 10s
  - 配置加载失败已有 warn 日志，`?? {}` 行为合理无需改动
  - 日志脱敏审查：`index.ts:63` 仅记录事件列表，不包含敏感信息，无需改动
  - `terminator-detect.ts` shell 注入：`DBUS_NAME/PATH` 来自 Terminator 环境变量，格式固定，风险可控
- Files created/modified:
  - index.ts (修复非空断言)
  - senders/custom-webhook.ts (AbortController 超时)
  - senders/feishu.ts (AbortController 超时)
  - senders/wechat-work.ts (AbortController 超时)

### Phase 2: 同步阻塞与资源泄漏修复
- **Status:** in_progress
- **Started:** 2026-06-24
- Actions taken:
  - `screen-flash/linux.ts` 子进程无回收 → 添加 `child.on("exit")` 回收
  - `screen-flash/win32.ts` `execSync` → `spawn` 异步非阻塞
  - `store.ts` 每次 `markSent` 同步写盘 → 防抖 1s 批量写入 + `flush()` 接口
  - `system/linux.ts` `execSync` 仅点击时调用一次，阻塞可接受，跳过
- Files created/modified:
  - senders/screen-flash/linux.ts
  - senders/screen-flash/win32.ts
  - store.ts

### Phase 2: 同步阻塞与资源泄漏修复（续）
- **Status:** complete
- Actions taken:
  - `terminator-detect.ts`: `isTerminalOccluded()` 添加 5s TTL 缓存，`getSystemIdleMs()` 添加 3s TTL 缓存
  - `delayed-dispatcher.ts`: PendingEntry 添加 failCount 字段，连续失败 3 次放弃重试
- Files created/modified:
  - terminator-detect.ts
  - delayed-dispatcher.ts

### Phase 3: 错误处理与边界情况修复
- **Status:** complete
- Actions taken:
  - dispatcher 并发控制(最多3个) + 部分成功即标记去重
  - custom-webhook 模板转义改用 JSON.stringify
  - feishu markdown 正文转义
  - linux gdbus 通知添加 error/exit 回退
  - cli 测试命令添加 15s 超时
- Files created/modified:
  - dispatcher.ts, senders/custom-webhook.ts, senders/feishu.ts
  - senders/system/linux.ts, cli.ts

### Phase 4: 类型安全与代码清理
- **Status:** complete
- Actions taken:
  - config.ts mergeConfig `as any` → 精确类型断言
  - index.ts cfg.log.level 运行时校验合法值
  - events.ts `Record<string, any>` → `Record<string, unknown>` + 类型守卫
  - message.ts 时间格式化改用 toLocaleString
- Files created/modified:
  - config.ts, index.ts, events.ts, message.ts

### Phase 2-4: 待开始
- **Status:** pending

### 附加任务：AGENTS.md 审计更新（2026-09-23）
- **Status:** complete
- Actions taken:
  - 校对 AGENTS.md 与当前代码，修正两处过期声明：
    - 子会话通知规则：当前只通知 `permission_required`（commit b4e4183 后完成/取消/失败均静默），AGENTS.md 原文写"仅 run_failed 仍通知"已过时
    - "输出"字段长度链：index.ts 捕获 1000 → tracker 累积/冻结截断 500 → message.ts 最终 500，展示上限为 500（原文未写具体数字）
  - 补充 CLI 渠道名坑：`cli.ts test` 匹配配置键 `system_message`，帮助/报错里的 `system` 匹配不到
  - 补充 planning 产物说明（plan.md/task_plan.md/progress.md/findings.md 非项目文档）
- Files created/modified:
  - AGENTS.md

### 新需求：远程控制通道（手机 → 插件 → opencode 应答）（2026-09-24）
- **Status:** complete（代码完成，tsc + smoke 通过；端到端待真实 Gotify/ntfy 联调）
- 需求：手机经 Gotify/ntfy 发命令，远程批准/拒绝权限、回答提问、追加指令、中断任务；全部出站，不监听端口
- Actions taken:
  - 新增 `control/` 模块：types / parser（命令解析）/ pending（待处理注册表 + 短码）/ controller（命令执行）/ gotify + ntfy（轮询 provider）
  - config.ts：新增 `control` 配置段（类型 + mergeConfig + resolveConfig + 默认模板）
  - index.ts：捕获 requestID 登记待处理并附加短码；`permission.replied`/`question.replied` 时清理；启动通道；`dispose` 停止轮询
  - 关键技术点：`PluginInput.client` 是 v1（无 question API），控制走自建 v2 客户端 `createOpencodeClient({ baseUrl: serverUrl })` → `permission.reply` / `question.reply` / `session.prompt` / `session.abort`
  - 关键坑：Gotify 读端必须用 client token（C 开头）；其 `since` 是"返回 id 小于该值"的降序语义，增量用"取最新 N 条 + 过滤 id > lastMax"
  - 走查修复：同毫秒插入导致排序不稳定（改用插入顺序）、provider `stopped` 未复位、ntfy 冗余判断
- Files created/modified:
  - control/{types,parser,pending,controller,gotify,ntfy}.ts
  - config.ts, index.ts, tsconfig.json, AGENTS.md, README.md, opencode-notify.yaml.example

### 增强：ntfy 通知按钮 + 一次性令牌 + 多会话/多进程隔离（2026-09-24）
- **Status:** complete（tsc + smoke 通过；端到端待真实 ntfy 联调）
- 需求：通知底部带按钮，手机点按即处理，无需手动发消息；不能重复处理
- Actions taken:
  - 新增 `senders/ntfy.ts`（`NtfyNotifySender`）：把 `Message.controlButtons` 渲染为 ntfy `Actions` 头，按钮 `http` 动作 POST 回 commandTopic 闭环；值含 `,;"'` 时自动加引号
  - 令牌升级为**一次性** `oc-<实例4位>-<随机6位>`（`control/tokens.ts`）：`PendingRegistry.consume` 用后即废，TTL 30 分钟
  - 多进程隔离：每个进程随机实例前缀，非属主进程读到不匹配令牌静默忽略（不发回执）
  - 会话码 `sc-xxxx`（`control/sessions.ts`）：say/stop 精确寻址；裸命令仅在"唯一会话/唯一待处理"时兜底，多条歧义则拒绝
  - 权限按钮：允许 /（始终允许）/ 拒绝；提问按钮：按选项生成（≤3）
  - `config.ts`：新增 notifyTopic / buttons / buttonAlways / tokenTtlMs + 回环校验（notifyTopic ≠ commandTopic）
  - 走查修复：**secret 绕过漏洞**（原 `tokens.some` 全文扫描 → 改为仅按钮动作 + ref 位令牌才免 secret）；裸 say/stop 跨会话串位
- Files created/modified:
  - senders/ntfy.ts, control/{types,parser,pending,tokens,sessions,controller}.ts
  - config.ts, index.ts, message.ts, doc/features.md, README.md, opencode-notify.yaml.example, AGENTS.md

### 重构：回复能力归位到渠道（删除顶层 control 块）（2026-09-24）
- **Status:** complete（tsc + 全部 smoke 通过；本地配置已迁移；端到端待联调）
- 动机：ntfy 的"通知"配置此前放在顶层 `control`，与其它渠道（都在 `channels.*`）不一致，凭据重复
- 变更：
  - **删除顶层 `control` 块**；新增内置渠道 `channels.ntfy` / `channels.gotify`，回复能力作为其可选子块 `reply`
  - ntfy/gotify 与其它渠道同构（`mode` + `events`），可参与 `remote_delay_channels`
  - `custom_webhook` 改为**命名多配置**（`custom_webhook: { my_slack: {...} }`），兼容旧单对象（`normalizeCustomWebhooks`）
  - 新增 `senders/gotify.ts`（`GotifyNotifySender`）；`NtfyNotifySender` 增加 `priority` 参数
  - `control/types.ts`：`ControlConfig` → `ReplyConfig`（输入 `ReplyConfigInput` + 解析后 `ReplyConfig`）
  - `config.ts`：`resolveReplyConfig(provider, channel)` 负责校验必需字段与回环（topic ≠ command_topic）
  - `index.ts`：`buildSenders` 统一 `register("ntfy"/"gotify")` + 遍历命名 webhook；`replyCfg = channels.ntfy?.reply ?? channels.gotify?.reply`
  - `cli.ts`：`check`/`test`/`info` 适配新渠道与命名 webhook（CLI 渠道名 = 配置键）
- 配置字段映射：`serverUrl→server_url`、`ntfyToken→token`、`notifyTopic→topic`、`commandTopic→reply.command_topic`、`receiptTopic→reply.receipt_topic`、`buttons→reply.buttons`、`buttonAlways→reply.button_always`、`pollIntervalMs→reply.poll_interval_ms`、`tokenTtlMs→reply.token_ttl_ms`、`maxPending→reply.max_pending`、`receipt→reply.publish_receipt`、`secret→reply.secret`；gotify：`appToken→app_token`、`clientToken→reply.client_token`、`appId→reply.app_id`
- Files created/modified:
  - senders/gotify.ts（新增）, senders/ntfy.ts, control/{types,controller}.ts, config.ts, index.ts, cli.ts
  - doc/features.md, README.md, opencode-notify.yaml.example, AGENTS.md
  - 本地 `~/.config/opencode/opencode-notify.yaml`（control → channels.ntfy.reply；custom_webhook(gotify) → channels.gotify）

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| tsc --noEmit | 全量 | 无类型错误 | 通过 | ✅ |
| control smoke-1 | parser + 令牌 + 会话码 + TTL | 30/30 | 30/30 | ✅ |
| control smoke-2 | secret 绕过回归 + 唯一性兜底 + 令牌一次性 | 13/13 | 13/13 | ✅ |
| 新配置解析 | ntfy/gotify/命名 webhook/回环/旧格式兼容 | 16/16 | 16/16 | ✅ |
| 本地配置迁移 | loadYamlConfig → resolveConfig | ntfy 回复就绪 | 就绪 | ✅ |
| 合并回执话题 | 删 receipt_topic，回执走 topic + 优先级可配 | 11/11 | 11/11 | ✅ |
| 端到端 | 真实 ntfy 按钮/命令往返 | 待联调 | - | ⏳ |

## 2026-09-24 远程应答修复（直跑模式「服务返回错误」）
- 根因：直跑模式无 HTTP 端口，`_input.serverUrl` 为死地址 `http://localhost:4096`，自建 v2 client 连不上 → `res.error` truthy → 回执带「(服务返回错误)」。
- 修复：`control/controller.ts` 新增 `buildV2Client()` 从注入 v1 client 的 `_client.getConfig()` 提取内存 `fetch`/认证 `headers` 构造 v2 client；`index.ts` 原样传 `_input.client`。
- 验证：`tsc --noEmit` 通过；模拟直跑注入实测 `permission.reply` 走内存 fetch、返回 `{data}`、认证头保留。
- **待用户端到端**：重启 opencode → 日志应出现 `client=injected` → 真机点按钮确认回执无「服务返回错误」。

## 2026-09-24 ntfy 命令通道：轮询 → 流式订阅（`reply.transport`）
- 新增 `control/ntfy-stream.ts` `NtfyStreamProvider`：长连接订阅 `GET .../json`，NDJSON 逐行；游标仅按 `event=message` 的 id 推进；断线带 `since` 重连补漏；看门狗 120s 无字节→重连；HTTP 400（游标被逐出）→ 重置游标；401/403 或 429(42909) 连续 3 次→熔断；429 按 Retry-After 退避；message id 去重（有界 256）。
- 新增 `control/ntfy-common.ts`：认证头 / URL 构造 / 回执发布，poll 与 stream 共用。
- `control/ntfy.ts`：`NtfyProvider` → `NtfyPollProvider`（保留 `transport: poll` 兜底），复用共享工具。
- 配置：`ReplyConfigInput/ReplyConfig` 增 `transport?: "stream" | "poll"`；`config.ts:resolveReplyConfig` 默认 `stream`。
- 工厂：`controller.ts:createProvider()` 按 transport 选择；启动日志增 `transport=`。
- 新增 `scripts/control-stream-smoke.ts`（mock ntfy 冒烟，4 场景）；`tsconfig.include` 纳入 `scripts/**/*.ts`。
- 文档：`doc/features.md` / `README.md` / `opencode-notify.yaml.example` / `config.ts` 模板 / `AGENTS.md`。

## Test Results（补充）
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| tsc --noEmit | 全量含 scripts | 无类型错误 | 通过 | ✅ |
| stream smoke | mock ntfy 4 场景（收消息/断线补+去重/400重置/看门狗/401熔断） | 全通过 | 全通过 | ✅ |
| stream e2e | 真实 ntfy 订阅+发布往返 | 收到 | 收到 | ✅ |
| 重启后启动日志 | opencode 重启 (15:53) | `transport=stream` + `client=injected` | 均出现 | ✅ |
| 重启后日志 | 15:53 之后 | 无 error/warn | 干净（仅插件已加载） | ✅ |
| 长连接 | 运行中进程到 ntfy | 1 条稳定 ESTAB | 主连接 55742 稳定持有 | ✅ |

## 遗留观察（用户决定打住，不再追查）
- 运行中 opencode 进程偶尔出现**第 2 条**到 ntfy 的 ESTAB（如 fd64→58672，约 60~70s 后被 45832 替换；主连接 55742 始终稳定）。
- 单进程单 provider 按代码只应持有 1 条连接；受控复测因 ss 采样按 hostname 匹配失败未完成，改按 IP 后用户叫停。
- 可能方向（仅记录，未证实）：Bun fetch keep-alive 连接池未及时销毁旧流 / 代理层行为 / 进程内其它组件。
- 不影响功能：无 error/warn、无 429、主连接稳定、命令往返可用。如后续服务端仍见多余请求，可从这一条入手。

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | 远程控制已实现（含按钮 + 一次性令牌 + 隔离），待真实 ntfy 联调 |
| Where am I going? | 端到端联调；如需再做 Gotify 文本命令验证 |
| What's the goal? | 手机远程处理 opencode 权限/提问/指令/中断 |
| What have I learned? | See findings.md |
| What have I done? | See above |
