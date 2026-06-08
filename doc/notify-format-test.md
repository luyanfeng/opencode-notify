# 通知内容格式验证

## 概述

覆盖所有事件类型的通知输出格式，验证 `route()` → `formatBody()` → `enrich()` 各阶段的输出。

---

## 测试用例

### TC1: `question.asked` → `permission_required`

**输入：**
```
type: "question.asked"
properties:
  sessionID: "ses_xxx"
  text: "要读取文件 /home/lyf/xxx 吗"
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

### TC2: `question.asked`（无 text）→ `permission_required`

**输入：**
```
type: "question.asked"
properties:
  sessionID: "ses_xxx"
  text: ""
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

**输入：**
```
type: "permission.asked"
properties:
  sessionID: "ses_xxx"
  tool: { name: "Bash" }
  permission: "command"
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 需要授权
事件：需要授权
会话：ses_xxx
详情：操作「Bash - command」需要您的授权许可
主题：熟悉项目
时间：{current_time}
```

**边界：`tool` 为字符串时：**
```yaml
tool: "Bash"
```
期望详情：`操作「Bash」需要您的授权许可`

**边界：`tool` 为对象无 `name` 时：**
```yaml
tool: { type: "FileRead", permission: "read" }
```
期望详情：`操作「FileRead - read」需要您的授权许可`

---

### TC4: `session.idle` → `input_required`

**输入：**
```
type: "session.idle"
properties:
  sessionID: "ses_xxx"
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 等待输入
事件：等待输入
会话：ses_xxx
详情：Agent 正在等待您的输入
主题：熟悉项目
时间：{current_time}
```

---

### TC5: `session.status`(idle) → `input_required`

**输入：**
```
type: "session.status"
properties:
  sessionID: "ses_xxx"
  status: { type: "idle" }
```

**期望输出：** 与 TC4 相同。

**非 idle 状态（busy/retry）不应触发通知：**
```
type: "session.status"
properties:
  sessionID: "ses_xxx"
  status: { type: "busy" }
```
期望输出：`null`（不通知）

---

### TC6: `session.error` → `run_failed`

**输入：**
```
type: "session.error"
properties:
  sessionID: "ses_xxx"
  error:
    name: "APIError"
    data: { message: "Rate limit exceeded" }
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

### TC7: `session.error`(MessageAbortedError) → `run_cancelled`

**输入：**
```
type: "session.error"
properties:
  sessionID: "ses_xxx"
  error:
    name: "MessageAbortedError"
    data: { message: "用户点击了中断按钮" }
```

**期望输出（有 sessionTopic）：**
```
[熟悉项目] 用户取消
事件：用户取消
会话：ses_xxx
详情：用户中断: 用户点击了中断按钮
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
