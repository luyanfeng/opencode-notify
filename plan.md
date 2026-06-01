# opencode-notify: opencode 通知插件 - 需求与实现计划

## 1. 项目定位

opencode-notify 是一个 opencode 通知插件，监听 opencode 会话中的关键事件，通过多种渠道将通知推送给用户。

**实现方式**: opencode 原生插件 (TypeScript)

---

## 2. 语言与技术栈选择

### 2.1 为什么是 TypeScript + Bun

| 选项 | 结论 | 理由 |
|------|------|------|
| **TypeScript** | ✅ 选定 | opencode Plugin API 类型定义在 `@opencode-ai/plugin` 中，原生 TS；Bun 直接执行 TS 无需编译步骤 |
| JavaScript | ❌ 排除 | 缺乏类型安全，opencode 插件生态以 TS 为主 |
| Go (独立二进制) | ❌ 排除 | 需要额外独立进程通信，无法利用 opencode 内置事件总线，违背插件设计初衷 |

### 2.2 技术选型详表

| 技术 | 用途 | 选型理由 |
|------|------|---------|
| **TypeScript** | 开发语言 | opencode 插件标准语言，类型安全 |
| **Bun** | 运行时/构建 | opencode 内置 Bun，可零配置直接运行 TS |
| **@opencode-ai/plugin** | 插件 SDK | 官方 Plugin/Hooks 类型 |
| **node:child_process** | 系统通知 | 调用平台原生通知命令 (osascript/notify-send/powershell) |
| **node:fetch** | HTTP 请求 (Webhook) | Bun/Node 内置，零依赖 |
| **node:fs** | 状态持久化 | 去重状态写本地 JSON |

### 2.3 零外部依赖原则

除 `@opencode-ai/plugin` 类型包外，尽可能**不引入外部 npm 依赖**：
- HTTP 请求用内置 `fetch`
- 文件操作用内置 `fs`
- 子进程用内置 `child_process`
- 保证插件轻量、无版本冲突风险

---

## 3. 核心功能

### 3.1 事件监听

| 通知事件 | 触发条件 | 映射到 opencode 事件 | 状态 |
|----------|---------|---------------------|------|
| `permission_required` | Agent 需要用户授权（如执行命令） | `permission.asked` + `question.asked` | ✅ 已验证 |
| `input_required` | Agent 等待用户输入 | `session.idle` / `session.status`(idle) | ✅ 已验证 |
| `run_completed` | 任务执行完成 | 待定（需组合判断） | 🔴 待开发 |
| `run_failed` | 任务执行失败 | `session.error` | ⚠️ 待测试 |
| `session_idle` | 会话长时间无活动 | `session.idle` | ✅ 已验证 |

**事件映射实测结论**：
- 权限请求走 `event` 总线，事件名为 **`permission.asked`**（不是 `permission.updated`）
- `permission.asked` properties: `{ id, sessionID, permission, patterns, metadata, always, tool }`
- `tool` 是对象 `{ name, type, ... }`，取 `.name` 或 `.type` 显示
- 通用询问事件名为 `question.asked`，也走 event 总线
- `session.idle` / `session.status` 均可用于 `input_required` 检测
- `session.error` 暂未验证，`run_completed` 无直接事件需后续设计

### 3.2 通知渠道

| 渠道 | 实现方式 | 优先级 |
|------|---------|--------|
| **系统通知** | macOS: osascript / Linux: notify-send / Windows: PowerShell | Phase 1 (MVP) |
| **企业微信** | 群机器人 Webhook (HTTP POST) | Phase 2 |
| **飞书** | Webhook Bot (HTTP POST) | Phase 2 |
| **自定义 Webhook** | 通用 HTTP POST，用户指定 URL 和模板 | Phase 2 |

### 3.3 配置方式

插件支持两种配置来源，按优先级：**YAML 文件** > **plugin options** > **默认值**

#### 方式一：YAML 配置文件（推荐）

`~/.config/opencode/opencode-notify.yaml` — 插件启动时自动加载，优先级最高。
每项配置均含详细中文注释。

```yaml
channels:
  system:
    enabled: true
  custom_webhook:
    enabled: true
    url: "https://gotify.example.com/message"
    headers:
      X-Gotify-Key: "your-token"
    template: '{"title":"{{title}}","message":"{{body}}","priority":5}'

events:
  - permission_required
  - input_required
  - run_failed

dedupe_seconds: 60
suppress_when_active: false
activity_timeout_ms: 30000
```

#### 方式二：opencode.json plugin tuple（覆盖 YAML）

```typescript
// opencode.json 中通过 plugin tuple 传入配置
{
  "plugin": [
    ["opencode-notify", {
      "channels": {
        "system": { "enabled": true },
        "wechat_work": { "enabled": false, "webhook_url": "" },
        "feishu": { "enabled": false, "webhook_url": "" },
        "custom_webhook": { "enabled": false, "url": "", "template": "" }
      },
      "events": ["permission_required", "input_required", "run_completed", "run_failed"],
      "dedupe_seconds": 60,
      "suppress_when_active": false
    }]
  ]
}
```

#### 方式二：opencode.json plugin tuple（覆盖 YAML）

- 基于复合 key `agent:event:sessionID` 的时间窗口去重
- 窗口时长可配置（默认 60 秒）
- 内存中的 Map 记录 + 可选 JSON 文件持久化（跨会话持久）
- 引入"预留发送"机制：预占发送时隙，发送失败则释放允许重试

---

## 4. 架构设计

### 4.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                   opencode-notify Plugin                 │
│                                                          │
│  ┌─────────────────┐     ┌──────────────┐               │
│  │   Plugin Entry  │────▶│    Config    │               │
│  │  (index.ts)     │     │  (config.ts) │               │
│  └────────┬────────┘     └──────────────┘               │
│           │                                              │
│           ▼                                              │
│  ┌─────────────────┐      ┌──────────────┐              │
│  │   Event Router  │─────▶│   Message    │              │
│  │  (events.ts)    │      │  (message.ts)│              │
│  └────────┬────────┘      └──────┬───────┘              │
│           │                      │                       │
│           ▼                      ▼                       │
│  ┌────────────────────────────────────────────────┐     │
│  │  Dispatcher (dispatcher.ts)                     │     │
│  │  ├─ 去重检查                                    │     │
│  │  └─ 分发到所有启用的 Sender                       │     │
│  └──────────┬─────────────────────────────────────┘     │
│             │                                            │
│     ┌───────┼───────────┬────────────────┐              │
│     ▼       ▼           ▼                ▼              │
│  ┌──────┐ ┌──────┐ ┌────────┐ ┌────────────────┐      │
│  │System│ │企业微信│ │ 飞书   │ │ 自定义 Webhook  │      │
│  │Sender│ │Sender │ │Sender  │ │ Sender          │      │
│  └──────┘ └──────┘ └────────┘ └────────────────┘      │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  DelayedDispatcher (delayed-dispatcher.ts)      │     │
│  │  ├─ 正常通知发出后，等 remote_delay_seconds 秒    │     │
│  │  ├─ 用户活跃 → 取消该会话所有待发延迟              │     │
│  │  └─ 最多重复 remote_delay_max_count 次            │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  ┌─────────────────────────────────────┐                │
│  │          State Store                 │                │
│  │   (store.ts)                         │                │
│  │   ├─ 去重记录 (内存 Map)              │                │
│  │   └─ JSON 文件持久化                   │                │
│  └─────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

### 4.2 目录结构

```
opencode-notify/
├── index.ts                 # 插件入口，导出 Plugin 函数
├── cli.ts                   # 诊断 CLI (check / test / log / info)
├── config.ts                # 配置类型定义 + 解析
├── message.ts               # Message 类型 + 格式化
├── events.ts                # 事件路由：opencode event → Message
├── dispatcher.ts            # 去重 + 分发逻辑
├── delayed-dispatcher.ts    # 远程延迟推送调度器
├── store.ts                 # 状态存储（去重记录）
├── utils.ts                 # 工具函数
├── senders/
│   ├── types.ts             # Sender 接口定义
│   ├── system/              # 系统通知（平台分包）
│   ├── screen-flash/        # 屏幕跑马灯
│   ├── wechat-work.ts       # 企业微信通知
│   ├── feishu.ts            # 飞书通知
│   └── custom-webhook.ts    # 自定义 Webhook
├── package.json
├── tsconfig.json
└── README.md
```

### 4.3 核心类型定义

```typescript
// ===== message.ts =====

/** 内部通知消息 */
interface Message {
  agent: string       // 触发事件的 agent 名称
  event: string       // 通知事件类型
  sessionID: string   // 会话 ID，用于去重
  title: string       // 通知标题
  body: string        // 通知正文
  workspace?: string  // 工作目录
}

// ===== senders/types.ts =====

/** 通知发送器接口 */
interface Sender {
  readonly name: string
  send(msg: Message): Promise<void>
}

// ===== config.ts =====

/** 插件配置 */
interface PluginConfig {
  channels: {
    system?: { enabled: boolean }
    wechat_work?: { enabled: boolean; webhook_url?: string }
    feishu?: { enabled: boolean; webhook_url?: string }
    custom_webhook?: {
      enabled: boolean
      url?: string
      method?: 'POST' | 'GET'
      headers?: Record<string, string>
      template?: string  // 消息模板（JSON 字符串）
    }
  }
  events?: string[]
  dedupe_seconds?: number
}
```

### 4.4 数据流

```
opencode event bus
       │
       ▼
event hook 收到 { type: "permission.asked" | "session.error" | ... }
       │
       ▼
events.ts 的 route() 判断事件类型
       │
       ├─ 匹配 → 构造 Message { agent, event, sessionID, title, body }
       │
       ▼
dispatcher.ts 的 dispatch()         ←── 立即发送到所有启用渠道
       │
       ├─ 1. 去重检查
       ├─ 2. 并发发送到各渠道
       └─ 3. 标记状态
       │
       ▼
delayed-dispatcher.ts 的 schedule()
       │
       ├─ 检查 remote_delay_channels 是否包含匹配渠道
       │     └─ 空 → 跳过
       │
       ├─ 等待 remote_delay_seconds 秒
       │     ├─ 期间用户活跃 → cancelForSession() 取消所有待发
       │     ├─ 期间会话删除 → cancelForSession() 取消
       │     └─ 超时 → 再次发送通知到 remote_delay_channels
       │
       └─ 重复最多 remote_delay_max_count 次后停止
```

### 4.5 模块职责详述

| 模块 | 文件 | 职责 |
|------|------|------|
| **Plugin Entry** | `index.ts` | 导出 default plugin 函数；初始化 Config → EventRouter → Dispatcher → Senders；返回 hooks 对象 |
| **Config** | `config.ts` | 定义 PluginConfig 类型；提供 `loadConfig()` 从 plugin options + env 合并配置 |
| **Message** | `message.ts` | 定义 Message 类型；提供 `formatTitle()`、`formatBody()` 等格式化函数 |
| **Event Router** | `events.ts` | 实现 `route(event: Event): Message \| null`；将 opencode 通用事件映射为内部 Message，不匹配则返回 null |
| **Dispatcher** | `dispatcher.ts` | 实现 `dispatch(msg)`；去重检查 → 遍历 senders → 发送 → 标记状态 |
| **Store** | `store.ts` | 去重状态管理；内存 Map + JSON 文件持久化；提供 `shouldSend()`、`markSent()`、`clearReservation()` |
| **Sender** | `senders/types.ts` | 定义 Sender 接口 |
| **System Sender** | `senders/system.ts` | 平台检测 + 调用系统通知命令 |
| **WeChatWork Sender** | `senders/wechat-work.ts` | 企业微信 Webhook POST（Markdown 格式） | 🟢 |
| **Feishu Sender** | `senders/feishu.ts` | 飞书 Webhook POST（卡片消息格式） | 🟢 |
| **Custom Webhook** | `senders/custom-webhook.ts` | 通用 HTTP 请求发送器（模板插值） | 🟢 |

### 4.6 系统通知适配策略

```typescript
function sendSystemNotification(title: string, body: string): void {
  switch (process.platform) {
    case 'darwin':
      // macOS: 用 osascript 显示通知
      execSync(`osascript -e 'display notification "${body}" with title "${title}"'`)
      break
    case 'linux':
      // Linux: 用 notify-send（需 libnotify）
      execSync(`notify-send "${title}" "${body}"`)
      break
    case 'win32':
      // Windows: PowerShell 弹窗
      execSync(`powershell -c "New-BurntToastNotification -Text '${title}', '${body}'"`)
      break
  }
}
```

### 4.7 Event Hook 使用策略

使用 `event` 通用钩子监听所有事件，内部路由：
- 优势：一次绑定，覆盖所有事件类型
- 无需为每种事件单独注册 hook
- 未来扩展新事件只需在 `events.ts` 中添加映射规则

```typescript
// index.ts 中注册
return {
  event: async ({ event }) => {
    const msg = route(event)  // events.ts: 尝试转 Message
    if (!msg) return           // 不关心的事件 → 跳过
    await dispatcher.dispatch(msg)
  }
}
```

---

## 5. 通知渠道优先级方案

### Phase 1 (MVP) - 核心渠道
- 系统通知 ✅ (最基础，直接可用，已验证)

### Phase 2 - 扩展渠道 ✅ 全部完成
- 自定义 Webhook (通用 HTTP POST，支持 Gotify 等) — ✅ 已实现并测试
- 企业微信 Webhook (群机器人，Markdown 消息) — ✅ 已实现
- 飞书 Webhook (卡片消息) — ✅ 已实现

---

## 6. 实现阶段

### Phase 1: 基础框架 ✅ 已完成

| # | 步骤 | 状态 | 可交付物 |
|---|------|------|---------|
| 1.1 | 项目初始化 (package.json, tsconfig) | 🟢 完成 | 可构建的项目结构 |
| 1.2 | 插件入口 `index.ts` | 🟢 完成 | 正确 Plugin 签名 |
| 1.3 | Config 模块 `config.ts` | 🟢 完成 | 配置解析 |
| 1.4 | Message 类型 `message.ts` | 🟢 完成 | 消息模型 |
| 1.5 | Event Router `events.ts` | 🟢 完成 | 事件→消息映射 |
| 1.6 | Store `store.ts` | 🟢 完成 | 去重状态管理 |
| 1.7 | Dispatcher `dispatcher.ts` | 🟢 完成 | 去重+分发核心 |
| 1.8 | System Sender `senders/system.ts` | 🟢 完成 | 系统通知 |
| 1.9 | 端到端集成测试 | 🟢 完成 | 跑通事件→通知 |
| 1.10 | 活跃抑制（TUI 激活时不通知） | 🟢 完成 | 用户活跃检测跳过通知 |

**里程碑**: ✅ 插件加载成功，权限请求与空闲事件均可弹出系统通知，活跃抑制可配置

### Phase 2: 消息渠道

| # | 步骤 | 状态 | 可交付物 |
|---|------|------|---------|
| 2.1 | 企业微信通知 `senders/wechat-work.ts` | 🟢 完成 | 企微 Webhook (Markdown) |
| 2.2 | 飞书通知 `senders/feishu.ts` | 🟢 完成 | 飞书 Webhook (卡片消息) |
| 2.3 | 自定义 Webhook `senders/custom-webhook.ts` | 🟢 完成 | 通用 HTTP + 模板插值，支持 Gotify |
| 2.4 | 渠道配置测试 | 🟢 完成 | Gotify 测试通过 (HTTP 200) |
| 2.5 | 配置分离 YAML | 🟢 完成 | ~/.config/opencode/opencode-notify.yaml |
| 2.6 | 配置项详细文档 | 🟢 完成 | YAML 文件内含完整中文注释 |

**里程碑**: 至少 2 个渠道测试通过 ✅（系统通知 ✅ + 自定义 Webhook ✅ + 企业微信 ✅ + 飞书 ✅）

### Phase 3: 完善体验

| # | 步骤 | 可交付物 |
|---|------|---------|
| 3.1 | README + 使用文档 | 🟢 完成 | 详细文档 |
| 3.2 | 调试/诊断模式 `cli.ts` | 🟢 完成 | 命令行诊断 (check/test/log/info) |
| 3.3 | 配置向导 | ⚫ 已取消 | YAML 注释 + check 已覆盖 |
| 3.4 | GitHub Actions 发布流程 | 🔴 | CI/CD |

**里程碑**: v1.0.0 发布

### Phase 4: 远程延迟推送

| # | 步骤 | 可交付物 |
|---|------|---------|
| 4.1 | 配置项 `remote_delay_channels` / `remote_delay_seconds` / `remote_delay_max_count` | config.ts |
| 4.2 | `DelayedDispatcher` 模块（延迟调度 + 取消 + 重试计数） | delayed-dispatcher.ts |
| 4.3 | 集成到 index.ts（立即通知后调度延迟推送，用户活跃/会话删除取消） | index.ts |
| 4.4 | 文档更新（YAML 模板 + README） | config.ts + README.md |
| 4.5 | 编译验证 | `tsc --noEmit` |

**里程碑**: 远程延迟推送功能完成，不增加外部依赖

---

## 7. 关键设计决策

### 7.1 事件映射策略（已验证）

opencode 的事件总线有以下与通知相关的事件：

| 事件名 | 触发时机 | properties 结构 | 映射 |
|--------|---------|----------------|------|
| `permission.asked` | 工具需要授权 | `{ id, sessionID, permission, patterns, metadata, always, tool }` | → `permission_required` |
| `question.asked` | 通用询问 | 待完善 | → `permission_required` |
| `session.idle` | 会话空闲 | `{ sessionID }` | → `input_required` |
| `session.status` | 会话状态变更 | `{ sessionID, status: { type } }` | type=idle → `input_required` |
| `session.error` | 会话出错 | `{ sessionID, error }` | → `run_failed` (待验证) |
| `session.created` | 新会话 | `{ sessionID, info }` | 预留，不做通知 |

`run_completed` 无直接事件，后续通过组合判断实现（如 todo.updated 全完成）。

### 7.2 零外部依赖（例外：js-yaml）

核心原则：除 `@opencode-ai/plugin`（仅类型，运行时不需要）外，尽可能不引入 npm 包。
- 内置 `fetch` 做 HTTP → 无需 axios/ky
- 内置 `child_process` → 无需 node-notifier
- 内置 `fs` 做持久化 → 无需 lowdb

**例外**: `js-yaml`（v4.1.1）用于 YAML 配置文件解析。js-yaml 本身零传递依赖，是 Node.js 生态最稳定的 YAML 解析库（2.5B+ 月下载量），引入风险极低。

### 7.4 去重策略

```
key = `${agent}:${event}:${sessionID}`
window = config.dedupe_seconds (default 60)

shouldSend(key):
  lastSent = store.get(key)
  if lastSent && now - lastSent < window → return false (去重)
  return true

markSent(key):
  store.set(key, now)
  persist to JSON file (可选)
```

首次实现使用内存 Map，后续视需要加入 JSON 文件持久化。

---

## 8. 技术栈一览

| 技术 | 用途 | 版本 |
|------|------|------|
| TypeScript | 开发语言 | 5.x |
| Bun | 运行时 | 内置 |
| @opencode-ai/plugin | 插件类型 | latest |
| js-yaml | YAML 配置解析（零传递依赖） | 4.1.1 |
| node:child_process | 系统通知 | built-in |
| node:fetch | HTTP 请求 | built-in |
| node:fs | 文件持久化 | built-in |

---

## 9. 参考资源

- opencode 插件文档: https://opencode.ai/docs/plugins
- opencode Plugin API 类型: packages/plugin/src/index.ts
- 飞书 Webhook 文档: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
- 企业微信 Webhook 文档: https://developer.work.weixin.qq.com/document/path/99110
