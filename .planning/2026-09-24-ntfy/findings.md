# Findings: ntfy 单话题双向回复

## ntfy Android 能力（librarian 两轮查证，源码+文档佐证）

### 不支持
- **通知内联回复（RemoteInput）**：Issue #1412 至今 open，ntfy-android 全仓库无 RemoteInput。
- **深链预填正文/标签**：`ntfy://` 深链只解析 `secure`/`display`/`topic`（DetailActivity.kt:208-211），不读 `message`/`tags`。
- **外部直接打开发布框**：PublishFragment 非 exported，仅 DetailActivity 内部调用。
- **widget/快捷方式/tile**：仓库检索为空。
- **https://ntfy.sh 被 App 接管**：manifest 无 https intent-filter → 走浏览器。

### 支持
- `ntfy://<host>[:port]/<topic>` 深链 → App BROWSABLE 接管 → **打开话题详情页**（底部消息栏，默认启用 DetailActivity.kt:93-95/414-447），可打字发布。
- `view` 动作 URL 用 `ntfy://` → App 接管（不走浏览器）。
- 通知动作类型：view / broadcast / http / copy，最多 3 个。
- http 动作可 POST 回同一 topic，可带自定义 headers（含 Tags）。
- App 内发布（分享 ACTION_SEND→EXTRA_TEXT 可预填正文但 topic 要手选——不如深链方案）。

### tags 语义（关键防回环依据）
- 发布：`X-Tags: a,b` 逗号分隔；JSON 发布体 `tags: []` 数组。
- 订阅端 JSON：`tags` 为 string array。
- **非 emoji tag 在通知弹窗不显示**（仅 App 详情列表显示原文）→ 适合做机器标记，弹窗干净。
- emoji shortcode 会前置到标题/正文展示。

### 单话题双向
- ntfy 无"忽略自己消息"机制，无官方单 topic 双向范式（官方/社区均为双 topic）。
- → 自过滤必须插件实现：插件发布的所有消息带 `tags:[bot_tag]`，订阅端过滤。

## 消息区分协议（本方案核心）
| 消息 | tags | 插件行为 |
|---|---|---|
| 通知/回执（插件发） | `[bot_tag]` | 忽略（防回环） |
| 按钮命令（手机 http 动作） | 无（可选 cmd） | 按命令解析 |
| 话题页打字（手机） | 无 | 显式协议解析（数字/answer/say/…），无动词→回执语法提示 |

## 回复协议（用户定稿：全部显式，绝不猜）
- 纯数字 n → 唯一待处理提问的第 n 个选项（**单提问内选项**；无提问/多提问/越界→拒绝+提示）
- `answer <文本>` → 回答提问（多提问→要求带令牌）
- `say [sc-xxxx] <文本>` → 续接会话
- `approve/always/deny [令牌]` / `stop [sc-xxxx]` / `status` / `help` → 不变
- 其它无动词文本 → **不执行**，回执语法提示（用户明确：不静默）
- 会话码不属主进程 → 静默忽略（防多进程回执噪音）

## 通知尾附命令提示（用户要求：不用记命令）
| 场景 | 追加行 |
|---|---|
| 权限请求 | `📱 回复: approve/deny/always <令牌>` |
| 提问有 n 选项 | `📱 回复: 1~n=选项 · answer 文本=自定义` |
| 提问无选项 | `📱 回复: answer 文本` |
| 完成/失败/取消 | `📱 回复: say 文本=继续 · stop=中断 · status=状态` |

## 按钮编排（ntfy 上限 3 动作）
| 场景 | 按钮 |
|---|---|
| 权限请求 | [允许][始终允许][拒绝]（http，满） |
| 提问 1~2 选项 | [选项…][回复(view)] |
| 提问 ≥3 选项 | [回复(view)] 单独 |
| 提问无选项 | [回复(view)] |
| 完成/失败/取消 | [回复(view)] |

## 现有代码落点
- `parser.ts:146` 无 secret 时任何合法动词放行（合并模式下需靠 bot_tag 过滤兜底）。
- `controller.ts resolveSession`：不认识的会话码返回 null → 会发"没有可用会话"回执 → 多进程噪音，需改为静默。
- `config.ts resolveReplyConfig`：现要求 command_topic 必填且 ≠ topic；需改为可选（缺省=topic）。
- `senders/ntfy.ts`：结构化 JSON 发布，加 tags/深链按钮容易。
- `RawCommandMessage` 需加 `tags?`；provider（stream/poll）需加 botTag 过滤（游标仍推进）。

## Phase 1 场景推理验证结论（2026-09-24）

10 场景走查全部通过，方案成立；发现 8 个缺口并纳入实现：

1. **≥3 选项提问正文必须枚举编号选项**（数字协议前提）→ question 通知 body 追加 `1. xxx 2. yyy`
2. **最近会话 recency 需显式 touch** → `SessionCodes.touch()`；不能依赖 `codeFor()`（回执文案也调用会污染 recency）
3. 多进程下纯数字/语法提示会**各进程重复回执** → 单进程无此问题，文档标注
4. **未知会话码 → 静默忽略**（区分"非属主"与"无会话"，后者才报错）
5. 提示行仅 ntfy 渠道 → `Message.replyHint` 新字段，ntfy sender 追加
6. 深链推导 `ntfy://<host>:<port>/<topic>`，https 默认 secure、http 加 `?secure=false`
7. **回执发布也必须带 bot_tag**（防回环是两条发布路径：通知 + 回执）
8. bot_tag 过滤必须在命令解析**之前**（通知尾提示含 "approve" 字样，过滤失效会被当命令）

关键安全推论：tag 过滤是合并模式的安全前提，实现时放在 provider 收到 message 的第一道。

## ntfy header 透传研究（librarian 第 3 轮，回答"会话码能否自动附带"）

### 结论
- **自定义 header（X-Session 等）→ 服务端白名单丢弃**（`server.go parsePublishParams` 逐个白名单读取，不遍历透传）；订阅 JSON 字段固定为 `id/time/event/topic/message/title/tags/priority/click/icon/actions/attachment/content_type/encoding/sequence_id`。
- **`Tags` / `Title` 等白名单头可作数据载体** → 映射进消息字段，订阅端可见。
  - `headers.Tags=sc-9f3a` → `tags=["sc-9f3a"]` ✅
- **http action 的 headers** 会被 Android App 加进发布请求（UserActionWorker.kt:88）→ 结合白名单：`headers.Tags` 生效 ✅，`headers.X-Session` 被丢弃 ❌。
- **无 correlation/in-reply-to 字段**；`sequence_id` 是"本条消息序列号（更新/删除用）"，非回复关联。
- Android 端**无任何"用户输入自动附元数据"**途径（PublishFragment 无 headers；broadcast 不收用户输入；ShareActivity 只预填正文）。

### 对本方案的启示
| 能否自动带会话码 | 场景 | 结论 |
|---|---|---|
| ✅ | 点**固定按钮**（http 动作，`headers.Tags=<sc-xxxx>`） | 可实现"会话级固定命令"（如 [状态]/[中断]），零手打 |
| ❌ | **自由文本打字**（话题页输入框） | 会话码只能手打或编进正文；上游限制，无法消除 |

→ 多会话精确 `say` 仍需手打 `sc-xxxx`；可用"会话级固定按钮"缓解固定动作类命令。
→ `tags` 承载会话码还可用于**多进程归属判断**（不属主→静默）。

## 动作按钮数量上限（实测确认，2026-09-24）

**服务端硬限制最多 3 个 action**，不是客户端折叠：
```
POST 4 个 actions → HTTP 400 {"code":40018,"error":"invalid request: actions invalid; only 3 actions allowed"}
POST 6 个 actions → HTTP 400 同上
POST 1/2/3 个     → HTTP 200 ✅
```
**不可配置**（源码核实）：`ntfy/action/action.go:20` `actionsMax = 3` 为编译期常量；
`server.yml` / `config.go` 均无 action 相关配置项；无环境变量/flag。Android 端另有一道
`DetailAdapter.kt:241 Math.min(...,3)` 展示截断。→ 双层硬限，改需自编译服务端+重打包 APK（不建议、不可移植）。
→ 按钮编排必须 ≤3；≥3 选项提问只能靠正文编号 + 数字协议（原方案不变）。

## copy 动作 / SEND_MESSAGE 广播（librarian 第 4 轮）

### `copy` 动作按钮 ✅（解决"半自动带会话码"）
- 服务端支持并保留 `{action:"copy", label, value}`，`value` 原样进订阅 JSON（action.go:27/33/75；model.go:132-144）。
- Android 点击 → `UserActionWorker.performCopyAction` → `copyToClipboard(value)`（UserActionWorker.kt:50/62-69；Util.kt:513-523）。
- 详情页按钮走 `DetailAdapter.runCopyAction`（另一条路径，也有效）。
- **限制（未真机验证）**：Android 10+ 后台（WorkManager 非前台）写剪贴板可能被系统静默丢弃。
- 用法：`value = "say sc-9f3a "`（带尾空格）→ 用户粘贴+补正文+发送 = **半自动带会话码**。

### `broadcast` 动作 ❌ 不能发消息
- 通知 broadcast 动作走 `io.heckel.ntfy.USER_ACTION`（给本机其它 App），**不**触发 `SEND_MESSAGE`；两者不交叉（BroadcastService.kt:42-49/129）。
- `SEND_MESSAGE` 广播（exported，无权限门槛）是给 Tasker/HTTP Shortcuts 的：extras `base_url`(可选)/`topic`(必填)/`message`(必填)/`title`/`tags`/`priority`；鉴权用 App 本地已存 user，不要求已订阅（BroadcastService.kt:51-75）。

### 手段能力矩阵
| 手段 | 收自由文本 | 自动带会话码 | 零输入 |
|---|---|---|---|
| http 按钮 | ❌ | ✅(headers.Tags) | ✅ |
| copy 按钮 | 半自动(粘贴+补) | ✅(value 写死) | 半 |
| view 深链 | ✅(话题页打字) | ❌ | ❌ |
| 话题页手打 | ✅ | ❌ | ❌ |
| 外部 App SEND_MESSAGE | 取决于外部 App | — | — |

## 非按钮输入通道全量盘点（librarian 第 5 轮）

| 通道 | 收自由文本 | 自动带元数据 | 结论 |
|---|---|---|---|
| 通知 action 按钮 | ❌（硬限 3） | ❌ | 无 RemoteInput（#1412 open） |
| `ShareActivity`（ACTION_SEND） | ✅（EXTRA_TEXT 预填正文） | ❌（topic 需手选） | 无 topic intent 入口 |
| **`ntfy://<topic>` 深链 → App 内输入** | ✅ | ✅（topic 在链接里） | **原生最优**；即 [回复] view 按钮 |
| Web/PWA 消息栏 | ✅ | ✅（打开即绑定 topic） | 最顺但要开浏览器 |
| 外部自动化（Tasker/HTTP Shortcuts）HTTP POST | ✅ | ✅（topic+token 内嵌） | 小组件，需自建 |
| `SEND_MESSAGE` 广播 | ✅（外部 App） | 由外部 App 定 | 通知按钮碰不到 |
| **`copy` 动作** | 半自动（粘贴+补正文） | ✅（value 写死会话码/令牌） | 见上节 |
| iOS App | ❌ | n/a | 无文本输入，同样 3 按钮 |
| 服务端 `X-Template` | n/a | ❌（无服务端 id 变量） | 不适用 |

### 不可行（已证）
- App Shortcut / Widget：ntfy 无（grep 空）。
- `intent://` URI 预填分享页：ntfy 无 `Intent.parseUri`，且 view 动作发 ACTION_VIEW、ShareActivity 只认 ACTION_SEND。
- 通知 broadcast 动作 → SEND_MESSAGE：不交叉（走 USER_ACTION）。

### 对方案的关键印证
原生 Android 上"既能收自由文本、又能带 topic 元数据"的**唯一零成本路径** = `ntfy://<topic>` 深链（[回复] view 按钮）；
`copy` 按钮额外解决"会话码/令牌不想手打"（粘贴即带）。

## 未确认项
- 锁屏/收起状态下 view 深链跳转在部分 Android 版本可能受限（源码层 filter 命中没问题，未真机实测）。
- `ntfy://host:port/topic` 自托管端口形式未实测（源码 authority 解析支持，待真机）。
