# 通知内容格式验证

## 概述

覆盖所有事件类型的通知输出格式。本文的**所有「期望输出」均已与 ntfy 服务端的真实消息逐字比对**（拉取 `/{topic}/json?poll=1` 历史消息核对），不是手写推测。

> **格式真值来源（改动格式时以代码为准，并同步本文）**
>
> - 标题：`message.ts:formatTitle()` → `opencode - {标签}`；有用户输入时被 `enrich` 换成 `[{输入前15字}…] {标签}`
> - 正文基础四行由 `formatBody()` 产出（顺序固定）：
>   `**事件：**「…」` → `**会话：** …` → `**时间：** …` → `**输入：** …`
> - `enrich()` 按此顺序后处理：
>   1. 有用户输入 → **替换** `输入：` 行内容（截 80）
>   2. 有助手输出 → **末尾追加** `输出：…` 行（截 500）
>   3. 有会话主题 → 在 `时间：` 行**之前**插入 `主题：…`
>
> 由此得到最终行序（**有主题 + 有输出**时最完整）：
>
> ```
> **事件：**「…」
> **会话：** …
> **主题：** …
> **时间：** …
> **输入：** …
> **输出：** …
> ```
>
> - ⚠️ 正文行是 **`输入：`**（承载事件详情），不是 `详情：`
> - ⚠️ `主题：` 在 `时间：` **之前**（`enrich` 用正则替换时间行实现），不是正文末尾
> - 标签映射 `EVENT_LABELS` / 详情文案 `defaultBody()`：见 `message.ts`

### 标签与详情文案对照表

| 事件 | 标签（`EVENT_LABELS`，进标题） | 详情（`defaultBody()`，进 `事件：「…」`） |
|---|---|---|
| `permission_required` | 需要授权 | `Agent 需要您的授权许可`（有表单标题时改为 `需要确认: {标题}`） |
| `run_completed` | 任务完成 | `任务执行完成` |
| `run_failed` | 任务失败 | `任务执行失败`（有 `error.message` 时改为 `错误: {消息}`） |
| `run_cancelled` | 用户取消 | `用户主动中断了任务` |

### 截断规则（两套，别混）

| 位置 | 函数 | 规则 |
|---|---|---|
| 事件详情入正文前（表单标题、错误消息） | `events.ts:truncate(s, 200)` | 超 200 字 → 前 **197** 字 + `...`（三个半角点） |
| 用户输入 | `message.ts:shortTitle(p, 80)` | 超 80 字 → 前 **79** 字 + `…`（单个省略号） |
| 助手输出 | `message.ts:shortTitle(s, 500)` | 超 500 字 → 前 **499** 字 + `…` |
| 标题里的输入摘要 | `message.ts:shortTitle(p, 16)` | 超 16 字 → 前 **15** 字 + `…` |
| 提问说明 `fields[i].description` | `index.ts:clampDisplay(s, 200)` | 超 200 字 → 前 **197** 字 + `...` |
| 提问标题 `fields[i].title` | `index.ts:clampDisplay(s, 100)` | 超 100 字 → 前 **97** 字 + `...` |
| 选项标签 `options[].label` | `index.ts:clampDisplay(s, 30)` | 超 30 字 → 前 **27** 字 + `...` |
| 选项说明 `options[].description` | `index.ts:clampDisplay(s, 80)` | 超 80 字 → 前 **77** 字 + `...` |

> 后三行只作用于**正文展示**：`options[].label` / `value` 原样进注册表（按钮标签与
> 提交给宿主的回传值不受截断影响），`fields[i].title/description` 也仍按原值登记待处理条目。
> ntfy 服务端消息硬限 4095 字节，超限直接 500 → 通知彻底丢失，所以这几个字段必须先截。

---

## 测试用例

### TC1: `form.created` → `permission_required`

> opencode 2.x 用 `form` 承载提问（`question.asked` 已随 V1 一起移除）。
> 会话 ID 在 `data.form.sessionID`（**不在** `data.sessionID`）。
> ⚠️ 本 TC 是**远程控制未启用**时的正文基线（`route()` + `formatBody` 的产物）。
> 启用远程控制时 `index.ts` 的 form 分支会**改写** `输入：` 行并追加 `令牌：/选项：/回复:`
> ——两种形态都列在下面，**期望输出必须与控制开关状态成对给出**，否则两者必然对不上。

**输入：**
```yaml
type: "form.created"
data:
  form:
    id: "frm_xxx"
    sessionID: "ses_xxx"
    title: "要读取文件 /home/lyf/xxx 吗"
    fields: [{ key: "q0", title: "要读取文件 /home/lyf/xxx 吗" }]
```

> `fields[0].title` 必须给：真问题只从 `fields` 取（`form.title` 只是 `route()` 用的详情来源），
> title 为空时 form 分支的 `输入：` 会退化成兜底文案「请做出选择」。

**期望输出（无 sessionTopic、无用户输入、未启用远程控制）：**
```
标题: opencode - 需要授权
**事件：**「需要确认: 要读取文件 /home/lyf/xxx 吗」
**会话：** ses_xxx
**时间：** {current_time}
**输入：** 需要确认: 要读取文件 /home/lyf/xxx 吗
```

**期望输出（有 sessionTopic="熟悉项目"）：**
```
标题: opencode - 需要授权
**事件：**「需要确认: 要读取文件 /home/lyf/xxx 吗」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 需要确认: 要读取文件 /home/lyf/xxx 吗
```

**启用远程控制时（同一输入，本例无 options 故无 `选项：` 块）：**
```
**输入：** 要读取文件 /home/lyf/xxx 吗
**令牌：** oc-xxxx-xxxxxx
**回复:** select <令牌> 文字=自由回答
```
> `输入：` 行取 `fields[i].description`，缺失则退回 `fields[i].title`；两者都空才是「请做出选择」。
> `fields[i].title` 与 `输入：` 内容**相同**时不追加 `问题：` 行（避免同一句话出现两次）。

---

### TC2: `form.created`（无 title）→ `permission_required`

**输入：**
```yaml
type: "form.created"
data:
  form:
    id: "frm_xxx"
    sessionID: "ses_xxx"
    title: ""
    fields: []
```

`title` 为空 → 回退 `defaultBody("permission_required")`（**不是**省略详情行）。

**期望输出（有 sessionTopic）：**
```
标题: opencode - 需要授权
**事件：**「Agent 需要您的授权许可」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** Agent 需要您的授权许可
```

---

### TC3: `permission.asked` → `permission_required`

> V2 不再有 `tool` / `permission` 字段，改为 `action` + `resources[]` + `message`，
> 三者按 `action - message - resources…` 顺序拼接。

**输入：**
```yaml
type: "permission.asked"
data:
  id: "prm_xxx"
  sessionID: "ses_xxx"
  action: "bash"
  message: "command"
  resources: ["ls -la"]
```

**期望输出（有 sessionTopic）：**
```
标题: opencode - 需要授权
**事件：**「操作「bash - command - ls -la」需要您的授权许可」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 操作「bash - command - ls -la」需要您的授权许可
```

⚠️ 详情本身用直角引号 `「…」` 包裹动作，外层 `事件：` 又用一层 `「…」`，因此是 `事件：「操作「…」需要您的授权许可」` 的嵌套形式（`formatBody` 无条件加外层引号）。

**边界：无 `message` 与 `resources` 时：**
```yaml
action: "bash"
```
期望 `输入：` 行：`操作「bash」需要您的授权许可`

**边界：`action` 也缺失时：**
期望 `输入：` 行：`Agent 需要您的授权许可`（回退 `defaultBody`）

---

### TC4: `session.idle` → `run_completed`（由 index.ts 状态机合成）

> ⚠️ `route()` 对 idle 事件**返回 null**；`run_completed` 不在 `events.ts` 生成，
> 而是由 `index.ts` 的会话状态机合成（子会话过滤 + 无活跃子会话后才发）。

**输入：**
```yaml
type: "session.idle"
data:
  sessionID: "ses_xxx"
```

**期望输出（有 sessionTopic）：**
```
标题: opencode - 任务完成
**事件：**「任务执行完成」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 任务执行完成
```

---

### TC5: `session.status`(idle) → 同 TC4

**输入：**
```yaml
type: "session.status"
data:
  sessionID: "ses_xxx"
  status: { type: "idle" }
```

`SessionStatus` 是可辨识联合（`{type:"idle"}` / `{type:"retry",…}` / `{type:"busy"}`），
所以读 `data.status.type` 是对的。

**期望输出：** 与 TC4 相同（`index.ts` 把 `session.status.type==="idle"` 与
`session.idle` 等价处理）。

**非 idle 状态不应触发通知：**
```yaml
type: "session.status"
data:
  sessionID: "ses_xxx"
  status: { type: "busy" }
```
期望输出：`null`（不通知）

---

### TC6: `session.execution.failed` → `run_failed`

> V2 用原生事件取代 V1 的 `session.error`；错误信息在 `data.error.message`
> （`SessionStructuredError`，不再是 `{name, data:{message}}` 结构）。

**输入：**
```yaml
type: "session.execution.failed"
data:
  sessionID: "ses_xxx"
  error: { type: "api", message: "Rate limit exceeded" }
```

**期望输出（有 sessionTopic）：**
```
标题: opencode - 任务失败
**事件：**「错误: Rate limit exceeded」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 错误: Rate limit exceeded
```

**边界：长文本截断：**
`data.error.message` 超过 200 字 → `输入：` 行截断为 `{前197字}...`

---

### TC7: `session.execution.interrupted` → `run_cancelled`（按 reason 过滤）

> V2 原生事件取代 V1 靠 `MessageAbortedError` 名称猜测的做法。
> `data.reason` 取值 `user` / `shutdown` / `superseded` / `inactivity`，
> **只有 `user` 发通知**，其余三个静默（且**不降级**为 `run_failed`）。
> 依据见 `AGENTS.md` 的 run_cancelled 条目。

**输入（唯一会通知的 reason）：**
```yaml
type: "session.execution.interrupted"
data:
  sessionID: "ses_xxx"
  reason: "user"
```

**期望输出（有 sessionTopic）：**
```
标题: opencode - 用户取消
**事件：**「用户主动中断了任务」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 用户主动中断了任务
```

**静默的 reason（期望输出均为 `null`）：**

| `reason` | 为何静默 |
|---|---|
| `shutdown` | opencode 关闭/重载；宿主自己就两处特殊排除它（不写 `idle_outcome`、通知走独立分支），此时报"用户取消"是噪音 |
| `superseded` | 本次执行被更新的执行取代；新执行会自行发完成/失败通知，这里再报一次是重复打扰 |
| `inactivity` | 空闲超时；V1 时代同样不通知（无对应错误类型） |

`reason` 缺失或为未知值同样**静默**（不猜、不默认当 `user`）。

**`run_cancelled` 未启用时：**
配置 `events` 中不含 `run_cancelled` → 返回 `null`，不降级为 `run_failed`。

---

### TC8: 延迟推送标记

由 `delayed-dispatcher.ts:markDelayBody()` 追加到正文**末尾**（先清掉旧的标记段再拼，避免重复累积）。

**基准正文（TC1 加上 sessionTopic，假设 `enrich` 已把时间定为 `2026-06-08 15:48:59`）：**
```
**事件：**「需要确认: 要读取文件 /home/lyf/xxx 吗」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** 2026-06-08 15:48:59
**输入：** 需要确认: 要读取文件 /home/lyf/xxx 吗
```

**第2次延迟推送（非最终）：**
```
**事件：**「需要确认: 要读取文件 /home/lyf/xxx 吗」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** 2026-06-08 15:48:59
**输入：** 需要确认: 要读取文件 /home/lyf/xxx 吗
─────────────────
⚠️ 延迟 第2/3次（下次约 2分钟后）
```

**最终次延迟推送：**
```
**事件：**「需要确认: 要读取文件 /home/lyf/xxx 吗」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** 2026-06-08 15:48:59
**输入：** 需要确认: 要读取文件 /home/lyf/xxx 吗
─────────────────
⚠️ 延迟 第3/3次（最终）
```

> 间隔文案由 `formatInterval()` 产出：`<60s` → `"N秒"`，否则 `"N分钟"`（四舍五入）。

---

### TC9: 无 sessionTopic 时的回退

`sessionTopic` 为空时（尚未收到 `session.created` / `session.renamed` 的标题）：

```
标题: opencode - 需要授权
**事件：**「Agent 需要您的授权许可」
**会话：** ses_xxx
**时间：** {current_time}
**输入：** Agent 需要您的授权许可
```

标题保持 `opencode - {标签}`，正文**不出现** `主题：` 行。

---

### TC10: text 超过 200 字截断

输入 text 为 300 字时，事件详情在**入正文前**被 `truncate(text, 200)` 截断：

```
**输入：** {前197字}...
```

注意是半角 `...`（三个点），与用户输入/助手输出的单字符 `…` 不同。

---

### TC11: `enrich` 的标题与输出行

这是 `enrich` 的两项独立增强（`route()` 本身不产这两项）：

**有用户输入时**（`userPrompt` 来自 `session.inbox.enqueued`）：
- 标题从 `opencode - 需要授权` 换成 `[{输入前15字}…] 需要授权`（截 16）
- `输入：` 行内容**被替换**为用户输入（截 80）——注意是替换，事件详情因此不再出现在正文里

**有助手输出时**（`assistantSummary` 来自 `session.text.delta` 累积）：
- 正文末尾追加 `输出：{摘要}`（截 500）

**两者都有时的完整形态**（与 ntfy 真实消息一致）：
```
标题: [帮我看看这个报错] 任务完成
**事件：**「任务执行完成」
**会话：** ses_xxx
**主题：** 熟悉项目
**时间：** {current_time}
**输入：** 帮我看看这个报错 /home/lyf/proj/src/index.ts 里的 connect 函数
**输出：** 已定位到 connect 的超时设置缺失，改为可配置项…
```

---

### TC12: 远程控制附注（仅 ntfy 渠道）

`index.ts` 对**每条**通知追加回复提示行（`回复:`），权限/提问额外追加令牌行与按钮。
这些行直接跟在 `输出：` 行之后（**插件不加分隔空行**；若看到空行，那是助手输出内容
自身以换行结尾造成的，不是格式的一部分）。

> ⚠️ 正文里的 **key 列一律是 markdown 加粗**（`**事件：** 「…」`），且 `**` 闭合后必须跟
> 一个空格/标点，否则 ntfy（goldmark）不渲染粗体。**没有会话码行**（`sc-xxxx` 已从正文移除），
> 回复提示行也**没有图标前缀**。选项行 `**N 标签**` 整体加粗，说明行用 `↳` 字符前缀表达从属
> （不能靠行首空格缩进，ntfy 渲染器会吃掉；`↳` 前的两个空格只是额外排版）。
> 编号刻意**不带 `#` 也不带 `.`**：回复语法是 `select <令牌> N`，正文写 `#1` 会诱导用户敲
> `select <令牌> #1`，而 `parser` 的 `/^\d+$/` 不匹配 `#1` → 被当自由回答提交给宿主并消费令牌。

**完成类通知（`run_completed` 等）** —— 注册 session 型凭证：
```
**输出：** v0.1.2 构建已触发（`36375511201`）。依赖集变化…等完成：
**回复:** say <令牌> 文本=继续 · stop <令牌>=中断 · status <令牌>=状态
```

**权限/提问通知** —— 多一行 `令牌：`，命令提示更短：
```
**输入：** 现在看个新问题：服务端使用nginx 代理后 websocket要如何配置
**输出：** 先查清项目实际暴露的 WebSocket 端点和 SSE 长连接路径 —— 配置必须对具体路径生效，不能给通用模板。
**令牌：** oc-4e12-200c86
**回复:** approve/deny/always <令牌>
```

**提问（form）通知** —— 显示真问题（`fields[i].title`）+ 补充说明（`fields[i].description`，
即 `输入：` 行的来源），并列出每个选项及其说明（`options[j].description`，截 80）：
```
**事件：**「Agent 需要您的授权许可」
**会话：** ses_f13d6126effevCJiTtPcujcX5e
**时间：** 2026/9/29 15:58:36
**输入：** 确认粗体渲染
**问题：** 粗体渲染
**选项：**
**1 红色**
  ↳ 红色选项说明
**2 蓝色**
  ↳ 蓝色选项说明
**令牌：** oc-6bd0-1d6837
**回复:** select <令牌> 1~2=选选项 · select <令牌> 文字=自由回答
```
> ⚠️ `form.title` 恒为占位 `Questions`，**不是**真问题；真问题只取 `fields`。
> `select` 的参数是**纯数字**才选第 n 项，**任意文字**按自由回答处理（只有 `select`，
> 没有 `option`/`选择`/`选项` 同义词）。
> ⚠️ 上例的 `输入：确认粗体渲染` / `问题：粗体渲染` 说明 `fields[0].title` 与
> `fields[0].description` 不同时才有两行；**只有 title 没有 description** 时二者内容相同，
> `问题：` 行会消失（不重复同一句话）。

ntfy 通知的 `actions` 按钮（≤3 个，服务端硬限）：

| 场景 | 按钮 |
|---|---|
| 权限 | `[允许]` `[始终允许]` `[拒绝]`（均为 http，回 POST topic） |
| 提问 ≤2 选项 | `[选项]` `[选项]` `[复制]` |
| 提问 ≥3 选项 / 0 选项 | `[复制]` |
| 完成类 | `[复制续接命令]`（copy，带尾空格）`[状态]`（http） |

> 提问类按钮在 opencode 2.x 下经**同包 `./tui` 入口**投递（终端进程内调 `session.form.reply`），
> 由 RPC 回调确认结果：成功后消费令牌；失败/超时保留令牌并如实回执。
> 需有终端客户端在运行，否则超时后回执「当前没有终端客户端在运行，请回电脑处理」。
> 权限按钮走 `ctx.permission.reply`，本就直接可用。

---

## 验证方式

事件映射层已用冒烟脚本**持续回归**（`route()` 的输出 + reason 过滤 + 开关过滤）：

```bash
bun scripts/events-route-smoke.ts
```

**核对真机格式**（拉 ntfy 服务端的历史消息与本文逐字比对）：

```bash
# 注意端点必须是 /{topic}/json；/json 会返回 HTML 页面而不是消息流，
# 且无 token 时 403。since 参数用 10m/1h/1d 这种单位。
curl -sN -H "Authorization: Bearer <token>" \
  "https://<server>/<topic>/json?poll=1&since=1d" | jq -r 'select(.event=="message") | .message'
```

其余通道的实发效果：

```bash
# 用 CLI 发送测试通知（会真的推手机/桌面）
bun cli.ts test [channel]

# 诊断配置与各渠道连通性
bun cli.ts check
```

> `test` 的渠道名取**配置键**：`system_message` / `wechat_work` / `feishu` / `custom_webhook`。
