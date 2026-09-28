# 通知内容格式验证

## 概述

覆盖所有事件类型的通知输出格式，验证 `route()` → `formatBody()` → `enrich()` 各阶段的输出。

---

## 测试用例

### TC1: `form.created` → `permission_required`

> opencode 2.x 用 `form` 承载提问（`question.asked` 已随 V1 一起移除）。
> 会话 ID 在 `data.form.sessionID`（**不在** `data.sessionID`）。

**输入：**
```
type: "form.created"
data:
  form:
    id: "frm_xxx"
    sessionID: "ses_xxx"
    title: "要读取文件 /home/lyf/xxx 吗"
    fields: [{ key: "q0" }]
```

**期望输出（无 sessionTopic）：**
```
opencode - 需要授权
事件：需要授权
会话：ses_xxx
时间：{current_time}
详情：需要确认: 要读取文件 /home/lyf/xxx 吗
```

**期望输出（sessionTopic="熟悉项目"）：**
```
[熟悉项目] 需要授权
事件：需要授权
会话：ses_xxx
主题：熟悉项目
时间：{current_time}
详情：需要确认: 要读取文件 /home/lyf/xxx 吗
```

---

### TC2: `form.created`（无 title）→ `permission_required`

**输入：**
```
type: "form.created"
data:
  form:
    id: "frm_xxx"
    sessionID: "ses_xxx"
    title: ""
    fields: []
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 需要授权
事件：需要授权
会话：ses_xxx
详情：Agent 需要您的授权许可
主题：熟悉项目
时间：{current_time}
```

---

### TC3: `permission.asked` → `permission_required`

> V2 不再有 `tool` / `permission` 字段，改为 `action` + `resources[]` + `message`，
> 三者按 `action - message - resources…` 顺序拼接。

**输入：**
```
type: "permission.asked"
data:
  id: "prm_xxx"
  sessionID: "ses_xxx"
  action: "bash"
  resources: ["ls -la"]
  message: "command"
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 需要授权
事件：需要授权
会话：ses_xxx
详情：操作「bash - command - ls -la」需要您的授权许可
主题：熟悉项目
时间：{current_time}
```

**边界：无 `message` 与 `resources` 时：**
```yaml
action: "bash"
```
期望详情：`操作「bash」需要您的授权许可`

**边界：`action` 也缺失时：**
期望详情：`Agent 需要您的授权许可`（回退 `defaultBody`）

---

### TC4: `session.idle` → `run_completed`（由 index.ts 状态机合成）

> ⚠️ `route()` 对 idle 事件**返回 null**；`run_completed` 不在 `events.ts` 生成，
> 而是由 `index.ts` 的会话状态机合成（子会话过滤 + 无活跃子会话后才发）。

**输入：**
```
type: "session.idle"
data:
  sessionID: "ses_xxx"
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 任务完成
事件：任务完成
会话：ses_xxx
详情：Agent 已完成当前任务
主题：熟悉项目
时间：{current_time}
```

---

### TC5: `session.status`(idle) → 同 TC4

**输入：**
```
type: "session.status"
data:
  sessionID: "ses_xxx"
  status: { type: "idle" }
```

**期望输出：** 与 TC4 相同（`index.ts` 把 `session.status.type==="idle"` 与
`session.idle` 等价处理）。

**非 idle 状态不应触发通知：**
```
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
```
type: "session.execution.failed"
data:
  sessionID: "ses_xxx"
  error: { type: "api", message: "Rate limit exceeded" }
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 任务失败
事件：任务失败
会话：ses_xxx
详情：错误: Rate limit exceeded
主题：熟悉项目
时间：{current_time}
```

**边界：长文本截断：**
`data.message` 超过 200 字 → 截断为 `{前197字}...`

---

### TC7: `session.execution.interrupted` → `run_cancelled`

> V2 原生事件取代 V1 靠 `MessageAbortedError` 名称猜测的做法，无需再判错误名。
> `data.reason` 取值：`user` / `shutdown` / `superseded` / `inactivity`
> —— 插件当前**不区分 reason**，四者一律发 `run_cancelled`。

**输入：**
```
type: "session.execution.interrupted"
data:
  sessionID: "ses_xxx"
  reason: "user"
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 用户取消
事件：用户取消
会话：ses_xxx
详情：用户主动中断了任务
主题：熟悉项目
时间：{current_time}
```

**`run_cancelled` 未启用时：**
配置 events 中不含 `run_cancelled` → 返回 `null`，不降级为 `run_failed`

---

### TC8: 延迟推送标记

**基准正文（TC1 加上 sessionTopic）：**
```
事件：需要授权
会话：ses_xxx
详情：需要确认: 要读取文件 /home/lyf/xxx 吗
主题：熟悉项目
时间：2026-06-08 15:48:59
```

**第1次延迟推送：**
```
事件：需要授权
会话：ses_xxx
详情：需要确认: 要读取文件 /home/lyf/xxx 吗
主题：熟悉项目
时间：2026-06-08 15:48:59
─────────────────
⚠️ 延迟 第1/3次（下次约 16:01:00 / 6分钟后）
```

**第3次（最终）延迟推送：**
```
─────────────────
⚠️ 延迟 第3/3次（最终）
```

---

### TC9: 无 sessionTopic 时的回退

当 `session.updated` 尚未触发时，`sessionTopic` 为空：

```
opencode - 需要授权
事件：需要授权
会话：ses_xxx
详情：Agent 需要您的授权许可
时间：{current_time}
```

标题保持 `opencode - {标签}`，正文保持 `详情` 行。

---

### TC10: text 超过 200 字截断

输入 text 为 300 字时，event detail 截断到 200 字：
```
详情：{前197字}...
```

---

## 验证方式

```bash
# 方式1：编写测试脚本
bun run scripts/test-format.ts

# 方式2：使用 CLI 工具发送测试通知
bun run cli.ts test
```
