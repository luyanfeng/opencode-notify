# opencode-notify

opencode 通知插件 — 监听会话中的关键事件，通过多渠道推送通知到你的手机、群聊或桌面。

## 功能特性

- 监听 `permission_required` / `input_required` / `run_failed` 等事件
- 多渠道通知：系统通知、企业微信、飞书、自定义 Webhook（Gotify / Bark / PushDeer 等）
- YAML 配置文件，每项参数均有详细注释
- 去重机制：同一事件在时间窗口内不重复发送
- 活跃抑制：检测到用户在操作 TUI 时可自动跳过通知
- 零外部运行时依赖（仅 js-yaml 用于配置解析）

## 平台支持

| 模块 | macOS | Linux | Windows |
|------|:-----:|:-----:|:-------:|
| 插件核心（事件监听/路由/分发） | ✅ | ✅ | ✅ |
| 自定义 Webhook / 企业微信 / 飞书 | ✅ | ✅ | ✅ |
| 诊断 CLI (`bun cli.ts`) | ✅ | ✅ | ✅ |
| **系统通知** | ✅ `osascript` 内置 | ⚠️ 需 `libnotify` 包 | ⚠️ 需 BurntToast 模块 |

**说明：**
- **macOS**: 系统通知使用 `osascript`，系统内置，开箱即用
- **Linux**: 系统通知使用 `notify-send`，来自 `libnotify`。桌面发行版通常预装，如缺失可 `apt install libnotify-bin` / `yum install libnotify`
- **Windows**: 系统通知使用 PowerShell `New-BurntToastNotification`，需额外安装 [BurntToast](https://github.com/Windos/BurntToast) 模块。Webhook 渠道不受影响
- 非系统通知模块（Webhook 推送、CLI 诊断）均为纯 HTTP/Node API，全平台一致

## 快速开始

### 1. 安装

将插件添加到 `~/.config/opencode/opencode.json` 的 `plugin` 列表中：

```json
{
  "plugin": [
    "file:///home/lyf/Documents/IdeaProjects/lyf/ai/opencode-notify/index.ts"
  ]
}
```

> 路径替换为你实际存放 `opencode-notify` 项目的目录。

### 2. 配置

创建 `~/.config/opencode/opencode-notify.yaml`，完整示例：

```yaml
channels:
  system:
    enabled: true

  custom_webhook:
    enabled: false
    url: "https://gotify.example.com/message"
    headers:
      X-Gotify-Key: "your-app-token"
    template: '{"title":"{{title}}","message":"{{body}}","priority":5}'

  wechat_work:
    enabled: false
    webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"

  feishu:
    enabled: false
    webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"

events:
  - permission_required
  - input_required
  - run_failed

dedupe_seconds: 60
suppress_when_active: false
activity_timeout_ms: 30000
```

### 3. 重启 opencode

关闭当前 opencode 会话，重新打开。插件自动加载，查看日志确认：

```bash
tail -f ~/.opencode-notify/plugin.log
```

看到类似输出即加载成功：

```
[2026-05-30T10:00:00.000Z] 插件已加载, 配置: events=["permission_required","input_required","run_failed"], suppressActive=false, timeout=30000ms
[2026-05-30T10:00:00.000Z] 系统通知渠道已启用
[2026-05-30T10:00:00.000Z] 自定义 Webhook 渠道已启用
```

## 通知渠道

### 系统通知

弹出操作系统原生通知横幅。

| 平台 | 实现 |
|------|------|
| macOS | `osascript` (display notification) |
| Linux | `notify-send`（需安装 `libnotify`） |
| Windows | PowerShell (New-BurntToastNotification) |

### 自定义 Webhook

通用 HTTP POST 发送器，支持任意 Webhook 服务。

**支持的服务举例：**

| 服务 | 文档 |
|------|------|
| Gotify | [gotify.net](https://gotify.net/) |
| Bark | [github.com/Finb/Bark](https://github.com/Finb/Bark) |
| PushDeer | [pushdeer.com](https://pushdeer.com/) |
| Slack Webhook | [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks) |
| Discord Webhook | [support.discord.com](https://support.discord.com/hc/en-us/articles/228383668) |

**配置参数：**

| 参数 | 说明 |
|------|------|
| `url` | Webhook 地址 |
| `method` | 请求方法 `POST` / `GET`，默认 `POST` |
| `headers` | 自定义请求头（如 `X-Gotify-Key`） |
| `template` | 消息模板，支持占位符 `{{title}}` `{{body}}` `{{event}}` `{{agent}}` `{{sessionID}}` |

**Gotify 配置示例：**

```yaml
custom_webhook:
  enabled: true
  url: "https://gotify.example.com/message"
  method: "POST"
  headers:
    X-Gotify-Key: "your-app-token"
  template: '{"title":"{{title}}","message":"{{body}}","priority":5}'
```

### 企业微信

通过群机器人 Webhook 发送 Markdown 消息。

**配置步骤：**

1. 在企业微信群中添加群机器人
2. 复制 Webhook URL
3. 填入配置文件

```yaml
wechat_work:
  enabled: true
  webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

消息包含：标题、事件详情、会话 ID。

### 飞书

通过自定义机器人或流程触发器 Webhook 发送卡片消息。

**配置步骤：**

1. 在飞书群中添加自定义机器人（或创建流程触发器）
2. 复制 Webhook URL
3. 填入配置文件

```yaml
feishu:
  enabled: true
  webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
```

消息格式：卡片消息，包含标题头、正文（Markdown）、分割线、脚注（会话 ID）。

## 事件映射

| 通知事件 | 触发场景 | 对应 opencode 事件 |
|----------|---------|-------------------|
| `permission_required` | Agent 需要授权（执行命令、读写文件等） | `permission.asked` / `question.asked` |
| `input_required` | Agent 等待用户输入 | `session.idle` / `session.status` (idle) |
| `run_failed` | 任务执行失败 | `session.error` |
| `run_completed` | 任务完成（预留，暂未实现） | 待组合判断 |

## 配置参考

### 配置文件位置

默认路径：`~/.config/opencode/opencode-notify.yaml`

可通过环境变量 `OPENCODE_NOTIFY_CONFIG` 自定义路径。

### 配置优先级

```
YAML 文件 > plugin options (opencode.json) > 环境变量 > 默认值
```

### 全部配置项

```yaml
channels:
  system:
    enabled: true              # 系统通知开关

  custom_webhook:
    enabled: false             # 自定义 Webhook 开关
    url: ""                    # Webhook 地址
    method: "POST"             # 请求方法 POST | GET
    headers: {}                # 自定义请求头
    template: ""               # 消息模板

  wechat_work:
    enabled: false             # 企业微信开关
    webhook_url: ""            # 群机器人 Webhook URL

  feishu:
    enabled: false             # 飞书开关
    webhook_url: ""            # 机器人/流程触发器 Webhook URL

events:                        # 订阅的事件列表
  - permission_required
  - input_required
  - run_failed

dedupe_seconds: 60             # 去重时间窗口（秒）
suppress_when_active: false    # 用户活跃时是否跳过通知
activity_timeout_ms: 30000     # 活跃超时判定（毫秒）
```

### 环境变量

| 变量 | 用途 |
|------|------|
| `OPENCODE_NOTIFY_CUSTOM_WEBHOOK_URL` | 覆盖 `custom_webhook.url` |
| `OPENCODE_NOTIFY_WECHAT_WEBHOOK` | 覆盖 `wechat_work.webhook_url` |
| `OPENCODE_NOTIFY_FEISHU_WEBHOOK` | 覆盖 `feishu.webhook_url` |
| `OPENCODE_NOTIFY_CONFIG` | 自定义 YAML 配置文件路径 |

### 活跃抑制

当用户正在操作 TUI（发消息、翻页、回应权限等），说明人在屏幕前，可跳过通知。
检测事件：`message.updated` / `permission.replied` / `question.replied` / `command.executed` / `tui.command.execute`

```yaml
suppress_when_active: true     # 开启抑制
activity_timeout_ms: 30000     # 30 秒无操作视为离开
```

## 日志与故障排查

插件日志位于 `~/.opencode-notify/plugin.log`，包含：

- 插件加载信息（配置、已启用渠道）
- 收到的事件（`[event] type=...`）
- 匹配到的通知
- 发送结果

```bash
# 实时查看日志
tail -f ~/.opencode-notify/plugin.log

# 查看最近的插件加载信息
grep "插件已加载" ~/.opencode-notify/plugin.log

# 查看事件流
grep "\[event\]" ~/.opencode-notify/plugin.log
```

### 常见问题

**Q: 插件未加载？**
确认 `opencode.json` 中 `plugin` 列表的路径正确，指向 `index.ts` 文件。

**Q: 通知没有弹出？**
1. 检查日志中是否出现 `[event] type=` 行，确认事件是否被监听到
2. 检查渠道是否已 `enabled: true`
3. 检查 Webhook URL 是否正确
4. 查看 `~/.opencode-notify/plugin.log` 中是否有错误信息

**Q: 企业微信/飞书通知失败？**
确认 Webhook URL 有效，网络可达。可通过 `curl` 直接测试：

```bash
curl -X POST <webhook_url> -H "Content-Type: application/json" -d '{"msgtype":"markdown","markdown":{"content":"**测试**"}}'
```

## 项目结构

```
opencode-notify/
├── index.ts                 # 插件入口
├── cli.ts                   # 诊断工具
├── config.ts                # 配置解析（YAML + options + env）
├── events.ts                # 事件路由
├── dispatcher.ts            # 去重分发
├── store.ts                 # 状态存储
├── message.ts               # 消息模型
├── senders/
│   ├── types.ts             # Sender 接口
│   ├── system.ts            # 系统通知
│   ├── custom-webhook.ts    # 自定义 Webhook
│   ├── wechat-work.ts       # 企业微信
│   └── feishu.ts            # 飞书
├── findings.md              # 研究记录
├── plan.md                  # 需求与实现计划
├── task_plan.md             # 任务跟踪
├── progress.md              # 进度日志
├── package.json
└── tsconfig.json
```

## 免责声明

> ⚠️ **个人项目，按需使用**
>
> 此插件主要面向作者个人使用场景开发和测试，不一定适合所有用户和环境。
>
> **已知局限：**
> - Windows 系统通知需额外安装 [BurntToast](https://github.com/Windos/BurntToast) PowerShell 模块
> - Linux 系统通知需 `libnotify` 包（桌面发行版通常预装）
> - 事件映射基于 @opencode-ai/plugin@1.15.12 的行为，后续版本升级可能影响兼容性
> - `run_completed` 事件暂未实现（opencode 无直接完成事件）
> - 仅在 Ubuntu 24.04 (X11) 环境下测试并使用，其它平台未验证
>
> 如有问题欢迎提 Issue，但不保证及时响应和修复。
