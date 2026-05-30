# 研究记录: opencode 插件系统与通知功能分析

## 1. opencode 插件系统分析

### 1.1 插件本质
TypeScript/JavaScript 模块，导出 `Plugin` 函数:
```ts
import type { Plugin } from "@opencode-ai/plugin"
export default (async ({ client, project, directory, $ }) => {
  return { /* hooks */ }
}) satisfies Plugin
```

### 1.2 PluginInput 上下文
```ts
type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // API 客户端
  project: Project                                   // 项目信息
  directory: string                                  // 配置目录
  worktree: string                                   // 工作树根目录
  serverUrl: URL                                     // 服务 URL
  $: BunShell                                        // Shell 执行器
}
```

### 1.3 Hooks 类型定义

| Hook | 用途 | 说明 |
|------|------|------|
| `event` | 通用事件监听 | 监听所有内部事件 |
| `config` | 配置注入 | 启动时拿到合并配置 |
| `tool.{name}` | 自定义工具 | 注册新工具 |
| `auth` | OAuth 认证 | 第三方认证流程 |
| `chat.message` | 消息拦截 | 修改发送给 LLM 的消息 |
| `chat.params` | 参数修改 | 修改 temperature 等参数 |
| `chat.headers` | 请求头注入 | 添加自定义请求头 |
| `permission.ask` | 权限拦截 | 覆盖权限决定 |
| `command.execute.before` | 命令预处理 | 在命令执行前修改 |
| `tool.execute.before` | 工具预处理 | 在工具执行前修改参数 |
| `tool.execute.after` | 工具后处理 | 修改工具执行结果 |
| `shell.env` | 环境变量 | 注入环境变量 |
| `experimental.*` | 实验性 API | 会话压缩等 |

### 1.4 关键事件列表 (透过 event hook)

**Session 事件:**
- `session.created` - 新会话创建
- `session.updated` - 会话更新
- `session.error` - 会话错误
- `session.deleted` - 会话删除
- `session.idle` - 会话空闲
- `session.diff` - 会话变更
- `session.status` - 会话状态
- `session.compacted` - 会话压缩

**Permission 事件:**
- `permission.asked` - 权限被请求
- `permission.replied` - 权限已回复

**Tool 事件:**
- `tool.execute.before` - 工具执行前
- `tool.execute.after` - 工具执行后

**其他:**
- `message.*` - 消息事件
- `file.*` - 文件事件
- `command.executed` - 命令执行
- `todo.updated` - Todo 更新
- `tui.*` - TUI 界面事件

### 1.5 插件加载方式
1. **npm 包**: `opencode.json` 中声明
2. **本地文件**: `.opencode/plugins/` 目录下 `*.ts` / `*.js`
3. **自动发现**: `.opencode/plugin/` 和 `.opencode/plugins/` 自动加载

### 1.6 依赖管理
- 本地插件可用 npm 包: 在配置目录加 `package.json`
- 启动时自动 `bun install`，缓存到 `~/.cache/opencode/node_modules/`

---

## 2. 技术可行性结论

**可行。** 基于以下理由:
1. opencode 的 Plugin API 提供了 `event` 通用钩子和特定钩子，足够实现通知功能
2. opencode 的 auth hook 可以复用做飞书等 OAuth 认证流程
3. TypeScript 生态有丰富的通知库和 HTTP 客户端
4. 插件支持本地文件 + npm 包，依赖管理成熟

---

## 3. 功能研究: TUI 窗口激活状态检测与通知抑制

### 3.1 需求

用户在 opencode TUI 终端窗口处于**桌面焦点/激活状态**时，
不需要弹出系统通知（用户已看着屏幕）。
只有当用户**切换到其他窗口**（浏览器、编辑器等）时才发送通知。

### 3.2 方案 A: 桌面窗口焦点检测

判断当前桌面哪个窗口处于焦点，再判断其是否是对应终端。

| 平台 | 方法 | 可行性 |
|------|------|--------|
| **macOS** | `osascript` / `lsappinfo` 查 frontmost app，匹配终端名 | ✅ 可行 |
| **Linux (X11)** | `xdotool getactivewindow` → PID → 比对终端进程 | ✅ 可行 |
| **Linux (Wayland)** | 无标准 API，依赖 compositor（`hyprctl`/`swaymsg`） | ❌ 不可靠 |
| **Windows** | PowerShell 调用 `user32` 获取 foreground window | ✅ 可行 |

**问题**：
- Wayland 越来越主流但不支持窗口焦点查询（安全设计）
- 需维护终端模拟器识别列表（Terminal.app, iTerm2, Warp, Ghostty, Alacritty, Kitty, Gnome Terminal, Konsole, Windows Terminal...）
- 用户运行在 tmux/SSH 远程会话中 → 完全无法检测
- 开多个终端窗口时容易判断错
- 代码量 ~100 行，维护成本高

**可靠性**: 中低

### 3.3 方案 B: TTY 前台进程组检测

检测当前哪个进程拥有 TTY 的前台进程组。

```bash
# Linux
ps -o pid,stat,tty,comm -t $(tty | sed 's/\/dev\///')
```

**问题**：
- 只判断进程组，不判断窗口焦点
- opencode 后台思考时不是前台进程，会误判
- macOS 和 Linux API 不同
- 同开多终端无法区分

**可靠性**: 中

### 3.4 方案 C: 基于事件总线的用户活跃度检测（推荐 ✅）

利用 opencode 事件总线判断用户**当前是否在交互**。

**用户活跃事件**：
| 事件 | 含义 |
|------|------|
| `message.updated` | 用户发送了消息 |
| `permission.replied` | 用户回应了授权 |
| `question.replied` | 用户回答了问题 |
| `command.executed` | 用户执行了命令 |
| `tui.command.execute` | 用户按键操作 TUI |

**核心逻辑**：
```typescript
const ACTIVITY_TIMEOUT = 30_000 // 可配置

let lastActivity = Date.now()

function isUserActivity(type: string): boolean {
    return [
        "message.updated",
        "permission.replied",
        "question.replied",
        "command.executed",
        "tui.command.execute",
    ].includes(type)
}

// event hook 中更新
if (isUserActivity(type)) {
    lastActivity = Date.now()
}

// 分发时判断
const isActive = (Date.now() - lastActivity) < ACTIVITY_TIMEOUT
if (isActive) return // 用户在看，不通知
```

**优点**：
- ✅ **完全跨平台**（macOS/Linux/Windows/SSH 远程均适用）
- ✅ **可靠**——用户活跃与"在看着 TUI"高度正相关
- ✅ **0 外部依赖**
- ✅ **低难度**——~10 行代码
- ✅ **可配置**——超时时间可调

**缺点**：
- 用户只看不操作（读输出）时可能误判，但这种情况不太需要通知

### 3.5 方案 D: 混合策略

```
用户近 30s 内有操作？
  ├─ 是 → 不通知（正在看 TUI）
  └─ 否 → 可选平台焦点检测
         ├─ macOS/LinuxX11 且终端在前台 → 不通知
         └─ 否则 → 发送通知
```

### 3.6 方案对比

| 维度 | A 窗口焦点 | B TTY 进程 | C 活跃度检测 ✅ | D 混合 |
|------|:---:|:---:|:---:|:---:|
| **跨平台** | ⚠️ 缺 Wayland | ✅ | ✅ | ✅ |
| **远程 SSH** | ❌ | ⚠️ | ✅ | ✅ |
| **可靠性** | 中低 | 中 | **高** | **高** |
| **技术难度** | 中高 | 中 | **低** | 中 |
| **外部依赖** | 平台命令 | 系统工具 | **无** | 少量平台逻辑 |
| **维护成本** | 高 | 中 | **低** | 中低 |
| **代码量** | ~100 行 | ~30 行 | **~10 行** | ~40 行 |

### 3.7 推荐与理由

**最终实现方案 C（用户活跃度检测）**：

1. 插件运行在 opencode 进程内，天然能访问事件总线
2. 跨平台零成本，SSH 远程同样生效
3. ~10 行代码，不增加维护负担
4. 用户活跃度与"在看着 TUI"高度正相关
5. 超时时间可配置，适应不同使用习惯

### 3.8 实现注意事项

1. **事件覆盖要全面**：除了消息和权限回复，`tui.command.execute` 也很重要——用户翻页、切换会话都算活跃
2. **超时默认值**：30s 较合理，短于系统通知的显示时长即可
3. **加载阶段初始值**：插件刚加载时 `lastActivity = Date.now()` ，避免刚启动时漏通知
4. **只抑制分发，不影响去重状态**：活跃时不发通知，但事件去重记录仍应更新，避免离开后重复发
┌─────────────────────────────────────────────┐
│               CLI Layer (cobra)              │
│  cmd/agent-notify/main.go                    │
│  internal/cli/ -> root, actions, menu, etc.  │
├─────────────────────────────────────────────┤
│           Application Services               │
│  internal/app/setup/   → 配置向导             │
│  internal/app/doctor/  → 诊断工具             │
│  internal/app/tester/  → 测试工具             │
├─────────────────────────────────────────────┤
│         Agent Hook Integration               │
│  internal/agentintegrations/ → Integration接口 │
│    ├── claude.go → Claude Code hooks 安装     │
│    └── codex.go  → Codex hooks 安装           │
│  internal/claudehooks/ → Claude hook 解析     │
│  internal/codexhooks/  → Codex hook 解析      │
├─────────────────────────────────────────────┤
│           Notification Engine                │
│  internal/notify/                            │
│    ├── message.go    → Message, Sender 接口   │
│    ├── dispatcher.go → 带去重的分发器          │
│    ├── sender.go     → 平台感知的 Sender 工厂  │
│    ├── format.go     → 消息格式化              │
│    ├── macos.go / linux.go / windows.go       │
│    ├── feishu.go     → 飞书通知               │
│    └── wechatwork.go → 企业微信通知            │
├─────────────────────────────────────────────┤
│              State & Config                  │
│  internal/config/ → YAML 配置管理             │
│  internal/state/  → 去重状态持久化 (JSON)     │
│  internal/common/ → 路径工具                  │
└─────────────────────────────────────────────┘
```

### 1.3 核心接口设计

**Sender 接口** (internal/notify/message.go):
```go
type Sender interface {
    Name() string
    Send(ctx context.Context, msg Message) error
}
```

**Message 结构**:
```go
type Message struct {
    Agent     string  // claude_code / codex
    Event     string  // permission_required / input_required / run_completed / run_failed
    SessionID string
    Workspace string
    Title     string
    Body      string
}
```

**Integration 接口** (internal/agentintegrations/integration.go):
```go
type Integration interface {
    Name() string
    DetectInstalled() bool
    SettingsPath(scope string) (string, error)
    Install(settingsPath, binaryPath string) error
    IsHookInstalled(settingsPath string) (bool, error)
}
```

### 1.4 事件映射

| Agent 事件 | Claude Hook | Codex Hook | 说明 |
|-----------|-------------|------------|------|
| `permission_required` | PermissionRequest | PermissionRequest | 需要授权 |
| `input_required` | Notification(waiting) | — | 等待输入 |
| `run_completed` | Stop | Stop | 任务完成 |
| `run_failed` | PostToolUseFailure | — | 任务失败 |

### 1.5 去重机制
- 基于 `agent:event:sessionID` key，在时间窗口内不重复发送
- 状态持久化到 `~/.agent-notify/state.json`
- 支持 `ReserveSend` 预占 + 超时清理

### 1.6 通知渠道
1. **系统通知** - macOS (osascript), Linux (notify-send), Windows (PowerShell)
2. **飞书** - 通过飞书开放 API / OAuth 认证
3. **企业微信** - 群机器人 Webhook

### 1.7 配置结构 (YAML)
```yaml
version: 1
agent:
  claude_code:
    enabled: true
    install_scope: user
  codex:
    enabled: false
    install_scope: user
notify:
  claude_code:
    events: [permission_required, input_required, run_completed, run_failed]
    channels:
      system: { enabled: true }
      feishu: { enabled: false }
      wechat_work: { enabled: false, webhook_url: "" }
  codex: { ... }
behavior:
  dedupe_seconds: 60
  send_timeout_seconds: 5
  locale: zh-CN
```

### 1.8 部署方式
- npm 包 `agent-notify` → JS launcher 下载 Go 二进制
- CLI 交互式配置向导 (survey库)
- 支持 `npx agent-notify` 一键运行

---

## 2. opencode 插件系统分析

### 2.1 插件本质
TypeScript/JavaScript 模块，导出 `Plugin` 函数:
```ts
import type { Plugin } from "@opencode-ai/plugin"
export default (async ({ client, project, directory, $ }) => {
  return { /* hooks */ }
}) satisfies Plugin
```

### 2.2 PluginInput 上下文
```ts
type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // API 客户端
  project: Project                                   // 项目信息
  directory: string                                  // 配置目录
  worktree: string                                   // 工作树根目录
  serverUrl: URL                                     // 服务 URL
  $: BunShell                                        // Shell 执行器
}
```

### 2.3 Hooks 类型定义

| Hook | 用途 | 说明 |
|------|------|------|
| `event` | 通用事件监听 | 监听所有内部事件 |
| `config` | 配置注入 | 启动时拿到合并配置 |
| `tool.{name}` | 自定义工具 | 注册新工具 |
| `auth` | OAuth 认证 | 第三方认证流程 |
| `chat.message` | 消息拦截 | 修改发送给 LLM 的消息 |
| `chat.params` | 参数修改 | 修改 temperature 等参数 |
| `chat.headers` | 请求头注入 | 添加自定义请求头 |
| `permission.ask` | 权限拦截 | 覆盖权限决定 |
| `command.execute.before` | 命令预处理 | 在命令执行前修改 |
| `tool.execute.before` | 工具预处理 | 在工具执行前修改参数 |
| `tool.execute.after` | 工具后处理 | 修改工具执行结果 |
| `shell.env` | 环境变量 | 注入环境变量 |
| `experimental.*` | 实验性 API | 会话压缩等 |

### 2.4 关键事件列表 (透过 event hook)

**Session 事件:**
- `session.created` - 新会话创建
- `session.updated` - 会话更新
- `session.error` - 会话错误
- `session.deleted` - 会话删除
- `session.idle` - 会话空闲
- `session.diff` - 会话变更
- `session.status` - 会话状态
- `session.compacted` - 会话压缩

**Permission 事件:**
- `permission.asked` - 权限被请求
- `permission.replied` - 权限已回复

**Tool 事件:**
- `tool.execute.before` - 工具执行前
- `tool.execute.after` - 工具执行后

**其他:**
- `message.*` - 消息事件
- `file.*` - 文件事件
- `command.executed` - 命令执行
- `todo.updated` - Todo 更新
- `tui.*` - TUI 界面事件

### 2.5 插件加载方式
1. **npm 包**: `opencode.json` 中声明
2. **本地文件**: `.opencode/plugins/` 目录下 `*.ts` / `*.js`
3. **自动发现**: `.opencode/plugin/` 和 `.opencode/plugins/` 自动加载

### 2.6 依赖管理
- 本地插件可用 npm 包: 在配置目录加 `package.json`
- 启动时自动 `bun install`，缓存到 `~/.cache/opencode/node_modules/`

---

## 3. 对比分析: agent-notify vs opencode-notify

| 维度 | agent-notify | opencode-notify (目标) |
|------|-------------|----------------------|
| 语言 | Go | TypeScript |
| 部署 | 独立二进制 + npm launcher | opencode 插件 (TS/JS) |
| 监听方式 | Agent Hook 机制 (stdin) | opencode 事件总线 (event hook) |
| 目标平台 | Claude Code / Codex | opencode (本身可调用多种模型) |
| 配置 | YAML 文件 + CLI 向导 | opencode.json + 插件选项 |
| 通知渠道 | 系统/飞书/企微 | 系统/飞书/企微/自定义 Webhook |
| 去重 | 本地 JSON 持久化 | 插件内部状态管理 |

### 3.1 关键差异
- agent-notify 是**外挂式**：通过 Agent 的扩展 Hook 监听事件
- opencode-notify 是**嵌入式**：作为 opencode 插件运行，直接访问内部事件
- opencode 本身的事件系统提供了更丰富的事件类型

---

## 4. 技术可行性结论

**可行。** 基于以下理由:
1. opencode 的 Plugin API 提供了 `event` 通用钩子和特定钩子，足够实现通知功能
2. opencode 的 auth hook 可以复用做飞书等 OAuth 认证流程
3. TypeScript 生态有丰富的通知库和 HTTP 客户端
4. 插件支持本地文件 + npm 包，依赖管理成熟

---

## 5. 功能研究: TUI 窗口激活状态检测与通知抑制

### 5.1 需求

用户在 opencode TUI 终端窗口处于**桌面焦点/激活状态**时，
不需要弹出系统通知（用户已看着屏幕）。
只有当用户**切换到其他窗口**（浏览器、编辑器等）时才发送通知。

### 5.2 方案 A: 桌面窗口焦点检测

判断当前桌面哪个窗口处于焦点，再判断其是否是对应终端。

| 平台 | 方法 | 可行性 |
|------|------|--------|
| **macOS** | `osascript` / `lsappinfo` 查 frontmost app，匹配终端名 | ✅ 可行 |
| **Linux (X11)** | `xdotool getactivewindow` → PID → 比对终端进程 | ✅ 可行 |
| **Linux (Wayland)** | 无标准 API，依赖 compositor（`hyprctl`/`swaymsg`） | ❌ 不可靠 |
| **Windows** | PowerShell 调用 `user32` 获取 foreground window | ✅ 可行 |

**问题**：
- Wayland 越来越主流但不支持窗口焦点查询（安全设计）
- 需维护终端模拟器识别列表（Terminal.app, iTerm2, Warp, Ghostty, Alacritty, Kitty, Gnome Terminal, Konsole, Windows Terminal...）
- 用户运行在 tmux/SSH 远程会话中 → 完全无法检测
- 开多个终端窗口时容易判断错
- 代码量 ~100 行，维护成本高

**可靠性**: 中低

### 5.3 方案 B: TTY 前台进程组检测

检测当前哪个进程拥有 TTY 的前台进程组。

```bash
# Linux
ps -o pid,stat,tty,comm -t $(tty | sed 's/\/dev\///')
```

**问题**：
- 只判断进程组，不判断窗口焦点
- opencode 后台思考时不是前台进程，会误判
- macOS 和 Linux API 不同
- 同开多终端无法区分

**可靠性**: 中

### 5.4 方案 C: 基于事件总线的用户活跃度检测（推荐 ✅）

利用 opencode 事件总线判断用户**当前是否在交互**。

**用户活跃事件**：
| 事件 | 含义 |
|------|------|
| `message.updated` | 用户发送了消息 |
| `permission.replied` | 用户回应了授权 |
| `question.replied` | 用户回答了问题 |
| `command.executed` | 用户执行了命令 |
| `tui.command.execute` | 用户按键操作 TUI |

**核心逻辑**：
```typescript
const ACTIVITY_TIMEOUT = 30_000 // 可配置

let lastActivity = Date.now()

function isUserActivity(type: string): boolean {
    return [
        "message.updated",
        "permission.replied",
        "question.replied",
        "command.executed",
        "tui.command.execute",
    ].includes(type)
}

// event hook 中更新
if (isUserActivity(type)) {
    lastActivity = Date.now()
}

// 分发时判断
const isActive = (Date.now() - lastActivity) < ACTIVITY_TIMEOUT
if (isActive) return // 用户在看，不通知
```

**优点**：
- ✅ **完全跨平台**（macOS/Linux/Windows/SSH 远程均适用）
- ✅ **可靠**——用户活跃与"在看着 TUI"高度正相关
- ✅ **0 外部依赖**
- ✅ **低难度**——~10 行代码
- ✅ **可配置**——超时时间可调

**缺点**：
- 用户只看不操作（读输出）时可能误判，但这种情况不太需要通知

### 5.5 方案 D: 混合策略

```
用户近 30s 内有操作？
  ├─ 是 → 不通知（正在看 TUI）
  └─ 否 → 可选平台焦点检测
         ├─ macOS/LinuxX11 且终端在前台 → 不通知
         └─ 否则 → 发送通知
```

### 5.6 方案对比

| 维度 | A 窗口焦点 | B TTY 进程 | C 活跃度检测 ✅ | D 混合 |
|------|:---:|:---:|:---:|:---:|
| **跨平台** | ⚠️ 缺 Wayland | ✅ | ✅ | ✅ |
| **远程 SSH** | ❌ | ⚠️ | ✅ | ✅ |
| **可靠性** | 中低 | 中 | **高** | **高** |
| **技术难度** | 中高 | 中 | **低** | 中 |
| **外部依赖** | 平台命令 | 系统工具 | **无** | 少量平台逻辑 |
| **维护成本** | 高 | 中 | **低** | 中低 |
| **代码量** | ~100 行 | ~30 行 | **~10 行** | ~40 行 |

### 5.7 推荐与理由

**Phase 2 实现方案 C（用户活跃度检测）**：

1. 插件运行在 opencode 进程内，天然能访问事件总线
2. 跨平台零成本，SSH 远程同样生效
3. ~10 行代码，不增加维护负担
4. 用户活跃度与"在看着 TUI"高度正相关
5. 超时时间可配置，适应不同使用习惯
6. 如需更精确，Phase 3 可补充平台焦点检测作为可选增强

### 5.8 实现注意事项

1. **事件覆盖要全面**：除了消息和权限回复，`tui.command.execute` 也很重要——用户翻页、切换会话都算活跃
2. **超时默认值**：30s 较合理，短于系统通知的显示时长即可
3. **加载阶段初始值**：插件刚加载时 `lastActivity = Date.now()` ，避免刚启动时漏通知
4. **只抑制分发，不影响去重状态**：活跃时不发通知，但事件去重记录仍应更新，避免离开后重复发
5. **配置暴露**：
   ```json
   {
       "suppressWhenActive": true,
       "activityTimeoutMs": 30000
   }
   ```
