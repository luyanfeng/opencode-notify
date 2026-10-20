# AGENTS.md

opencode 通知插件（TypeScript，Bun 运行，opencode 2.x 插件）。监听会话事件 → 多渠道推送；手机可经 ntfy/Gotify 反向应答权限与提问。

## 命令

- 类型检查（无 test/lint/build 脚本，TS 层面只此一招）：`npx tsc --noEmit`
  （会先打印几行 npm info 噪音，看 exit code；`tsconfig.json` 已含 `scripts/**/*.ts`）
- CLI 诊断（bin 指向 `cli.ts`，用 bun 跑，别用 node）：
  `bun cli.ts check` / `bun cli.ts test [channel]` / `bun cli.ts log [n]` / `bun cli.ts info`
  - `test` 的渠道名取**配置键**：`system_message` / `ntfy` / `gotify` / `wechat_work` / `feishu` / `custom_webhook` 下的自定义名。`screen_flash` 不在 test 名单内。
  - `test` 会**真发**一条样例通知到已启用渠道（ntfy/企业微信会推到手机、群）。只改了渲染逻辑以外的东西时别顺手跑。
- 本地冒烟（无需网络/opencode，全部应 exit 0；改对应模块后跑对应脚本）：
  - `bun scripts/control-protocol-smoke.ts` — 协议解析 / 配置合并 / 按钮编排 / 令牌生命周期
  - `bun scripts/control-stream-smoke.ts` — 流式 provider（mock ntfy：重连补漏、400 重置、看门狗、401 熔断、bot_tag 过滤）
  - `bun scripts/events-route-smoke.ts` — `route()` 事件映射 + interrupted reason 过滤
  - `bun scripts/form-reply-bridge-smoke.ts` — 服务端表单应答桥（确认/失败/超时/复用/dispose）
  - `bun scripts/control-credential-sharing-smoke.ts` — 进程级凭证共享 + 指纹重建/裁剪
  - `bun scripts/instance-registry-smoke.ts` — location → 实例注册表
  - `bun scripts/permission-routing-smoke.ts` — 授权应答路由决策
  - `bun scripts/screen-flash-smoke.ts` — 跑马灯显示后端选择（Wayland→XWayland）+ 脚本语法自检
- 真实 ntfy 集成（**会推手机通知**，需运行时配置）：`bun scripts/ntfy-integration.ts tags|guard|gate|loopback|preview|copy|actions`
  （token 通常按话题授权，只能用配置里的 `topic`，随机话题 403）
- 运行期产物：`~/.opencode-notify/plugin.log`、`state.json`、`claims/`。

## 打包/发布（当前有坑）

- ⚠️ **`package.json` 的 `files` 白名单漏了 `control/`**：`"*.ts"` 只匹配根目录，`senders/` 是显式加的。
  已核验：`npm pack` 出来的 0.8.2 tarball 没有 `control/`，`index.ts` 一加载就
  `Cannot find module './control/instance-registry.js'`。新增顶层目录必须显式加进 `files`。
- 改 `files` 后用 `npm pack --dry-run` 核对清单，别凭感觉。
- `scripts/*.ts` 被 `!scripts/*.ts` 排除（冒烟脚本不进包），但 **`scripts/linux-marquee.py` 必须保留**——`senders/screen-flash/linux.ts` 按相对路径 spawn 它。
- 发布只走 npm（README 明确不再发 GitHub Release）；版本号写 `package.json`，历史 tag 形如 `v0.8.1`。
- 两个 lockfile 并存且都与 `package.json` 不同步：`package-lock.json` 版本号仍是 0.8.1，`bun.lock` 里包名是旧的 `opencode-notify`、依赖写的是 `@opencode-ai/plugin`（代码实际 import `@opencode/plugin`）。`node_modules` 是 npm 装的，别用 `bun install` 覆盖。

## 关键约定（容易踩坑）

- **import 写 `.js`，文件其实是 `.ts`**：`"type": "module"` + `moduleResolution: bundler`，全库如此，不要"修正"。
- **"输出"长度由两处共同决定**：`session-tracker.ts`（`BUCKET_MAX_BYTES=3072` 累积并从头部截断、`freezeAssistantSummary` 冻结）→ `message.ts:138`（`shortTitle(assistantSummary, 500)`）。**"输入"另走一路**：`index.ts:285` 源头 `slice(0, 1000)`，`message.ts` 里标题取 16 字、正文取 80 字。
- ⚠️ **`body.replace()` 的替换串带变量插值时必须用函数形式** `(m) => …`：字符串形式会解释 `$&`/`` $` ``/`$'`/`$$`，而输入来自用户与模型（含 `$` 很常见），命中就是正文被撑爆/串行。现存函数形式：`message.ts:134,142`、`index.ts:446,450`（`index.ts:453` 也是字符串形式，但无插值，安全）。
- **`text-format.ts` 是正文分渠道改写的公共件**：`stripInlineBold` / `bodyWithReplyHint` / `clampBodyBytes(3600)`（**保尾**令牌行，UTF-8 不切半个字符）。即时与延迟两条发送路径都各自调用，新增渠道别绕过。
- **同一份 `msg.body` 到各渠道会被改写，勿只看 ntfy**：ntfy `markdown:true` + 唯一渲染 Actions；企业微信 markdown；飞书 `escapeMarkdown` **故意不转义 `*`**（否则整张卡片都是 `\*\*事件：\*\*`），`` ` ``/`_`/`#`/`]` 仍转义；gotify/custom-webhook 去粗体；`system_message` **只发 事件/会话/时间/输入/输出 五行**（白名单正则在 `senders/system/index.ts`，加正文行要同步这里）；`screen_flash` 完全忽略正文。
- ⚠️ **提问正文的展示字段有长度上限**（`index.ts` 的 `clampDisplay`：title 100 / description 200 / label 30 / desc 80）——ntfy 硬限 4095 字节，超限直接 500 → **通知彻底丢失**。截断只发生在拼正文；`options`/`optionValues`/`optionDescs` 三个数组**必须原样且等长**（按下标取回传值，错位就提交错答案；提交用 `optionValues[i]`，不能是 label）。
- ⚠️ **正文选项编号不带 `#`**（写 `**1 红色**`）：回复语法是 `select <令牌> N`，`#1` 不匹配 `/^\d+$/`，会被当自由回答提交并消费令牌 → 静默错答。
- **`form.created` 的真实结构**（实测 2.0.19）：`form.title` 恒为占位 `"Questions"`，真问题在 `fields[i].title`、补充说明在 `fields[i].description`、选项在 `fields[i].options[j]`；`formID = data.form.id`，**会话 ID 在 `data.form.sessionID`**（不在 `data.sessionID`），`location.directory` 在**事件顶层**。事件被映射成 `permission_required`，要区分权限/提问只能看原始 `type`。
- **`run_completed` 不在 `events.ts` 生成**，由 `index.ts` 会话状态机合成（`session.idle`/`session.status(idle)` + `hasActiveChildren()`）。**已定论，勿再考证**：原生 `session.execution.succeeded` 按单 session 结算、不等子会话，不能替代。
- **`run_cancelled` 只对 `reason === "user"` 通知**（`events.ts` 的 `NOTIFIABLE_INTERRUPT_REASONS`），`shutdown`/`superseded`/`inactivity` 静默且**绝不降级成 `run_failed`**。
- **子会话（background task，有 parentID）只通知 `permission_required`**，完成/失败/取消全静默（`index.ts` 的 `finishNotification` 开头）。

## 远程控制（凭证强制协议，用户明确要求，勿回退）

- 命令只有：`approve/deny/always <令牌>`、`answer <令牌> <文本>`、`select <令牌> <数字|文本>`、`say <令牌> <文本>`、`stop <令牌>`、`status <令牌>`、`help`。**无动词简写已废除**。
- **无令牌 / 无效 / 异主（前缀不符） / 已消费 / 过期 → 完全静默**（仅写日志，不回执）；`execute` 对 kind 不匹配返回 `null` 静默。语法帮助由通知正文的 `replyHint` 行承担，**不要加"语法提示回执"**（会自激）。
- **执行成功才消费令牌**：`approve/always/deny/answer/choose` 走 `callBridge()`，失败保留令牌（TTL 内可重试）并在回执里写明原因；`status` 验证不消费；完成类注册 `session` 型凭证（TTL 内可反复 say/stop）。`PendingRegistry.add()` **幂等**（同 `requestID` 复用令牌，只刷标题/选项/TTL）——opencode 会对同一事件连发多次，轮换令牌会让用户手里的令牌立刻失效。
- `select` 是唯一的选择入口，在 `parser.finalize` 分流：纯数字 → `choose`，其它文字 → `answer`（所以 `execute` 的 `case "answer"` 也覆盖了"用 select 回自由文本"）。选项越界/无选项在 `controller.execute` 校验。
- **令牌 `oc-<inst4>-<rand6>` 跨 5 处耦合**：`control/tokens.ts`（生成/正则）→ `runtime-state.ts`（实例前缀）→ `pending.ts`（注册表）→ `parser.ts`（凭证语法）→ `controller.ts`（门卫）。改格式必须同步。
- **隔离粒度是「server 进程」不是「插件实例」**：实例前缀与注册表都在 `globalThis.__opencodeNotifyControlState__`（每 location 一份实例，owner 变了不能让令牌作废）。**只有 owner 写注册表**（`finishNotification` 开头的 `isActive()` 闸门在所有 `registerPending` 之前）。配置变更靠 `token_ttl_ms`+`max_pending` 指纹重建，重建后 `restore()` **显式裁剪一次**。
- **`permission.reply` 受「实例 location」门控**（否则报 `Permission request not found`）→ owner 经 `control/instance-registry.ts`（会合点 `globalThis.__opencodeNotifyInstances__`）把应答交给会话所属 location 的实例。注册表**只登记 `replyPermission`**，别暴露完整 ctx。路由依据 `PendingItem.locationDirectory`（来自事件顶层 `location.directory`，缺失用 `ctx.session.get` 兜底——它不受 location 门控）。
- **三种失败措辞不要合并**：目标无实例 → `PermissionTargetNotOpenError`；宿主 not found → `PermissionAlreadySettledError`；其余原样抛。三者都保留令牌。
- **提问（form）应答走 `tui.ts`**：服务端 ctx **没有** form 域，`form.reply` 只在 TUI/CLI 插件上下文。链路 `手机 → index.ts → RPC(form-reply-rpc.ts) → tui.ts → form.reply → methods.confirm → index.ts`。要点：
  - RPC 注册**按 location 作用域**，**每个实例都要注册自己那份**（放单例 `activate` 之外）；等待表必须放 `globalThis.__opencodeNotifyFormReplyWaiters__`。
  - **必须等 `confirm`**（默认 5s，`form_reply_timeout_ms`）：`ok:true` 才消费；`ok:false`/超时 → 抛错、回执原因、**保留令牌**。区分"没人处理"与"已处理"只能靠确认。
  - **事件会重放** → 消费方必须幂等（`inFlight` + 已结算静默）。Effect 错误 `String(e)` 是 `[object Object]`，用 `tui.ts` 的 `describeError`。
  - permission 与 form 机制**相反勿混**：permission 按实例 location 门控需服务端路由；form 按 `formID` 在客户端侧定位。详表见 `doc/v2-plugin-form-mechanism.md` 第 8.9 节（改 form 前先读该文档）。

## ntfy / Gotify 通道

- `reply` 配置挂在**渠道下**（`channels.ntfy.reply` / `channels.gotify.reply`），无顶层 `control` 块；二者互斥，`index.ts` 只启动一个命令通道。
- **默认合并单话题**：省略 `reply.command_topic` → 命令话题 = 通知话题，靠 `tags:[bot_tag]` 的 `isSelfMessage()` 在**解析命令之前**过滤自身消息防回环。填了 `command_topic` → 分离双话题，`copy_button` 强制 false。
- 命令读取默认 `stream`（`control/ntfy-stream.ts` 长连接：keepalive 45s、看门狗 120s、断线带 `since=<最后 message id>`、400 重置游标、401/403 熔断）；`poll` 走 `control/ntfy.ts`。**游标只按 `event=message` 的 id 推进**（`open`/`keepalive` 的 id 不在缓存，用作 `since` 会整段重放）。
- 按钮编排（ntfy 服务端硬限每条 **≤3 个 action**，`senders/ntfy.ts:buildActions`）：权限 `[允许][始终允许][拒绝]`；提问 ≤2 选项 `[选项][选项][复制]`，0 或 ≥3 选项仅 `[复制]`（正文列编号）；完成类 `[复制续接命令][状态]`。`copy` 的 value 是 `select <令牌> ` / `say <令牌> `（**带尾空格**）。
- 回执有内建限流（10s / 8 条），超限丢弃并告警——自激的最后一道防线，别顺手删。
- `custom_webhook` 是**命名多配置**（`custom_webhook: { my_slack: {…} }`），旧单对象写法仍兼容（归一成 key `custom_webhook`）。

## 进程 / 多实例

- **每个 location 各加载一份插件实例**，而事件流是 server 级公共流 → 必须靠 `process-singleton.ts` 收敛：只有 owner 订阅事件、发通知、跑命令通道。会合点是 `globalThis.__opencodeNotifyRuntime__`（模块级状态实测不共享，`ctx.storage` 也按 location 隔离）。选举规则是**最新注册者直接夺权**（不是"首个上位 + teardown 交接"）。改这里同步 `index.ts` 的 `activate/deactivate` 与 `finishNotification` 的 `isActive()` 闸门。日志判据：`单例: 本实例已上位` / `已让位` / `插件卸载`。
- **跨进程去重靠 `store.ts` 的 O_EXCL 按键占位**（`open(path,"wx")`）：① 占位文件写 owner token，`clearReservation` 释放前校验归属；② 占位创建失败**记 error 后照常发送**（送达优先于去重）；③ 占位保留 24h，构造时 `pruneClaims()` 懒清理。

## 部署与配置

- ⚠️ **opencode 2.x 的 `plugin` 数组必须是目录，不接受 `file://` 单文件**：写文件路径只会打一条 `configured plugin path must be a directory` 的 WARN 然后**静默跳过**（插件完全不加载、无报错）。改完必须重启 `opencode serve`。
  判定是否加载：`~/.local/share/opencode/log/opencode.log` 里有 `msg="loading plugin" id=…opencode-notify`；插件自己的日志里是 `插件已加载`。
  （`doc/install.md` 里仍写着 `file://…/index.ts` 的本地写法，是过时的，别照抄。）
- 运行时配置在 `~/.config/opencode/opencode-notify.yaml`（首次启动自动生成），模板见 `opencode-notify.yaml.example`。
- 配置优先级 **YAML > plugin options > 默认值**（`config.ts` 的 `loadYamlConfig`/`mergeConfig`/`resolveConfig`）。`mergeConfig` 按渠道逐字段合并、`reply` 子块单独合并，但 `events` 是**整体替换**不是拼接。
- **新增配置项要同步 3 处**：`config.ts` 的 `DEFAULT_CONFIG_TEMPLATE`（首次运行生成用）、`opencode-notify.yaml.example`、README「配置参考」。
- `channels.*.mode`：`all`（即时，延迟另由 `remote_delay_channels` 决定）/ `delay_only`（仅延迟）/ `none`。
- 不要改仓库根目录的 `config.json`（gitignored，是本仓库 opencode agent 模型配置，不是插件配置）。
- 平台依赖：`system_message` 在 Linux 走 gdbus→notify-send、Windows/macOS 各有实现；`screen_flash` 仅 Linux（python3 + PyGObject/GTK3）与 Windows（PowerShell + WinForms），macOS 静默忽略；`terminator-detect` 需 `TERMINATOR_UUID`（结果 5s TTL 缓存，避免高频 `execSync`）。
- ⚠️ **跑马灯在 Wayland 下要强制走 X11 后端**：GTK3 的 Wayland 后端不支持 override-redirect 顶层覆盖层，窗口能创建但**用户看不见**。`senders/screen-flash/linux.ts` 的 `resolveEnv()` 在 `WAYLAND_DISPLAY` 且 `DISPLAY` 有值时设 `GDK_BACKEND=x11`（走 XWayland）——**别删这个判断**，否则跑马灯在 Wayland 会话静默失效。脚本侧另有 `get_primary_monitor()` 返回 None 的回退（Wayland 无 primary monitor 概念，不回退会 `AttributeError` 秒退）。

## 架构速览

```
index.ts (服务端入口, exports ".")  events.ts route() → message.ts enrich/format
  │                                  → dispatcher(即时) / delayed-dispatcher(延迟)
  │                                  → senders/{system,screen-flash,wechat-work,feishu,ntfy,gotify,custom-webhook}
  ├─ process-singleton.ts  每 location 一实例 → 只留最新注册者 active
  ├─ control/             手机 → 插件 → 宿主（全出站，无监听端口）
  │   controller.ts (命令执行/凭证门卫/按钮编排) ← OpencodeBridge 窄接口（index.ts 用 ctx 实现）
  │   parser.ts · pending.ts · tokens.ts · runtime-state.ts · instance-registry.ts
  │   ntfy-common.ts · ntfy-stream.ts(默认) · ntfy.ts(poll) · gotify.ts · poll-loop.ts
  └─ form-reply-bridge.ts   服务端侧派发/等确认（等待表在 globalThis）

tui.ts (exports "./tui", 由 CLI 自动加载, 跑在终端进程)
  form-reply-rpc.ts 契约（两端共用同一 definition 对象，各写一份会静默失配）
  手机应答提问: ntfy → index.ts → RPC → tui.ts → form.reply → confirm → index.ts
```

- `events.ts:route()` 只做事件 → `Message` 映射；`session.idle`/`session.status(idle)` 不进 route，由 `index.ts` 状态机处理。
- `session-tracker.ts`：会话活跃/空闲、父子关系、用户输入与助手增量累积（驱动抑制与延迟推送取消）。
- V1 的 `message.part.updated`/`message.updated`/`question.*`/`session.updated`/`command.executed`/`session.error`/`permission.updated` 在 2.x **已不存在**；采集改用 `session.text.delta`（增量）、`session.inbox.enqueued`、`session.created`（扁平载荷）/`session.renamed`。

## 文档与规划产物

- `doc/features.md`（功能细节）、`doc/install.md`（安装/平台依赖，注意上面说的 file:// 过时处）、`doc/notify-format-test.md`（各渠道渲染样例）、`doc/v2-plugin-form-mechanism.md`（2.x form 应答机制与实证，改 form 前必读）。
- `openspec/`：spec-driven 变更（`openspec/config.yaml` 要求产出用 zh-CN，SHALL/MUST 保留英文）；流程入口在 `.opencode/commands/opsx-*.md`。已归档 3 个 change。
- 根目录 `plan.md` / `task_plan.md` / `progress.md` / `findings.md` 与 `.planning/` 是 planning-with-files 会话产物（已 gitignore），**不是项目文档**，别当参考资料、别打包。`test-*.ts` 也是 gitignore 的临时脚本。
- 提交信息用中文、conventional 前缀（`fix(通知):` / `docs(readme):` / `chore:`），一次提交聚焦一件事。
