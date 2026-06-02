# opencode-notify

opencode 通知插件 — 监听会话关键事件，通过多渠道推送通知到手机、群聊或桌面。

> ⚠️ **个人项目，按需使用** — 主要在 Ubuntu 24.04 (X11) 环境测试，其他平台可能存在问题。
> 如有问题欢迎提 [Issue](https://github.com/luyanfeng/opencode-notify/issues)，不保证及时响应和修复。

## 功能一览

- **多渠道通知**：系统通知 + 屏幕跑马灯 + 企业微信 + 飞书 + 自定义 Webhook
- **会话感知抑制**：活跃会话智能过滤冗余通知，不遗漏 `run_failed` 等重要事件
- **Terminator 子屏检测**：自动识别子屏最大化遮挡场景，被隐藏的会话强制通知
- **远程延迟推送**：正常通知发出后，对远程渠道额外延迟补偿，防止错过
- **去重机制**：同一事件在时间窗口内不重复发送
- **渠道级事件过滤**：每个渠道可独立配置监听哪些事件，灵活分流
- **零外部运行时依赖**：仅 `js-yaml` 用于配置解析
- **诊断 CLI**：验证配置、发送测试通知、调试事件流

## 平台支持

| 模块 | macOS | Linux | Windows |
|------|:-----:|:-----:|:-------:|
| 插件核心（事件监听/路由/分发） | ✅ | ✅ | ✅ |
| 自定义 Webhook / 企业微信 / 飞书 | ✅ | ✅ | ✅ |
| 诊断 CLI | ✅ | ✅ | ✅ |
| **系统消息通知** | ✅ `osascript` | ⚠️ 需 `libnotify` | ✅ WinRT Native Toast |
| **屏幕跑马灯** | ❌ | ✅ Ubuntu 24.04 X11 | ✅ PowerShell+WinForms |

> **已测试渠道：** 系统通知、企业微信、自定义 Webhook（Gotify）。飞书等渠道理论可用，暂未验证。

## 快速开始

### 1. 安装

```bash
npm install -g @freely01/opencode-notify
```

详细安装方式（npm / 本地 / Bun）及平台依赖说明 → [doc/install.md](doc/install.md)

### 2. 注册插件

编辑 `~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["@freely01/opencode-notify"]
}
```

### 3. 配置

首次启动自动生成默认配置 `~/.config/opencode/opencode-notify.yaml`，或参考项目中的 `opencode-notify.yaml.example`。

```yaml
channels:
  system_message:
    enabled: true
  wechat_work:
    enabled: true
    webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
  custom_webhook:
    enabled: true
    url: "https://gotify.example.com/message"
    headers:
      X-Gotify-Key: "your-app-token"

events:
  - permission_required
  - input_required
  - run_failed

suppress_when_active: true
activity_timeout_ms: 15000
suppress_events_when_active:
  - permission_required
  - input_required

log:
  level: info
```

完整配置项参考 → [配置参考](#配置参考)

### 4. 验证

```bash
# 查看插件加载日志
tail -f ~/.opencode-notify/plugin.log

# 使用诊断 CLI 发送测试通知
bun run cli.ts --test

# 查看配置概览
bun run cli.ts --config
```

---

## 通知渠道

每个渠道可独立配置监听事件，不填则继承全局 `events`。

| 事件值 | 说明 |
|--------|------|
| `permission_required` | Agent 需要用户授权（执行命令、读写文件等） |
| `input_required` | Agent 等待用户输入 |
| `run_failed` | 任务执行失败 |
| `run_completed` | 任务执行完成（技术预留，暂未实现） |

### 系统消息通知

| 平台 | 实现 |
|------|------|
| macOS | `osascript`（内置） |
| Linux | `notify-send`（需 `libnotify`） |
| Windows | WinRT Native Toast |

### 屏幕跑马灯

通知时屏幕四边彩色高亮闪烁，视觉更醒目。

![跑马灯效果](doc/de.png)

```yaml
screen_flash:
  enabled: true
  duration: 3.0        # 持续秒数
  speed: 4.0           # 移动速度因子
  intensity: 0.9       # 不透明度 0.0~1.0
```

- **Ubuntu 24.04 X11**: Python + PyGObject(GTK 3) 创建透明覆盖窗口，60fps 彩色灯光沿四边循环运动
- **Windows**: PowerShell + .NET WinForms 创建屏幕四边彩色闪烁边框（8px 宽），中间透明可点击穿透
- 非阻塞执行，不影响通知发送速度

### 自定义 Webhook

通用 HTTP 发送器，支持任意 Webhook 服务（Gotify / Bark / PushDeer / Slack / Discord 等）。

| 参数 | 说明 |
|------|------|
| `url` | Webhook 地址 |
| `method` | `POST` / `GET`，默认 `POST` |
| `headers` | 自定义请求头 |
| `template` | 消息模板，支持 `{{title}}` `{{body}}` `{{event}}` `{{agent}}` `{{sessionID}}` |

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

```yaml
wechat_work:
  enabled: true
  webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

消息包含：标题（加粗）、事件详情、会话 ID。

### 飞书

通过自定义机器人或流程触发器 Webhook 发送卡片消息。

```yaml
feishu:
  enabled: true
  webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
```

消息格式：interactive 卡片消息，包含标题头、Markdown 正文、分割线、脚注。

### 远程延迟推送

正常通知发出后，对指定渠道额外延迟补偿推送。用户在延迟期间回到 TUI 操作 → 自动取消。

```yaml
remote_delay_channels:
  - wechat_work
  - custom_webhook
remote_delay_seconds: 60
remote_delay_max_count: 3
```

**注意：** 仅影响额外延迟推送，不影响正常通知（该发就发）。用户在该会话中操作（输入消息、回应权限等）自动取消所有待发延迟。

---

## Terminator 子屏遮挡检测

> 详细设计原理 → [doc/features.md](doc/features.md#4-terminator-子屏幕遮挡检测)

当你在 Terminator 中最大化某个子屏幕时（`Ctrl+Shift+X`），其他子屏被完全遮挡。插件自动检测此场景，被遮挡的会话即使活跃也强制发送通知。

**检测策略：**

```
事件被活跃抑制
  ↓
Terminator 窗口是当前 X 活跃窗口？     ← xdotool + xprop
  否 → 用户在别的应用中（浏览器/IDE）→ 强制通知
  是 → 本屏可见 → 正常抑制
```

**外部依赖**（检测失败自动降级，不影响正常抑制）：

| 工具 | 用途 | 安装 |
|------|------|------|
| `xdotool` | 获取活跃窗口 ID | `apt install xdotool` |
| `xprop` | 查询窗口 WM_CLASS | 系统自带 |

---

## 事件映射

| 通知事件 | 触发场景 | opencode 事件 |
|----------|---------|---------------|
| `permission_required` | Agent 需要授权 | `permission.asked` / `question.asked` |
| `input_required` | Agent 等待用户输入 | `session.idle` / `session.status(idle)` |
| `run_failed` | 任务执行失败 | `session.error` |
| `run_completed` | 任务完成（预留） | — |

---

## 配置参考

### 配置文件位置

默认路径：`~/.config/opencode/opencode-notify.yaml`

### 配置优先级

```
YAML 文件 > plugin options (opencode.json) > 默认值
```

### 全部配置项

```yaml
channels:
  system_message:
    enabled: true
    events: []
  screen_flash:
    enabled: false
    duration: 3.5
    speed: 5.0
    intensity: 0.85
  custom_webhook:
    enabled: false
    url: ""
    method: "POST"
    headers: {}
    template: ""
  wechat_work:
    enabled: false
    webhook_url: ""
  feishu:
    enabled: false
    webhook_url: ""

events: [permission_required, input_required, run_failed]
dedupe_seconds: 60

suppress_when_active: true
activity_timeout_ms: 15000
suppress_events_when_active:
  - permission_required
  - input_required
session_stale_timeout_ms: 600000

remote_delay_channels: []
remote_delay_seconds: 60
remote_delay_max_count: 3

log:
  level: info
```

### 活跃抑制

当用户在 opencode TUI 中操作时，屏上已可见的通知被智能过滤。追踪的用户操作事件：`message.updated` / `permission.replied` / `question.replied` / `command.executed` / `tui.command.execute`。

| 事件 | 活跃时行为 |
|------|:---------:|
| `permission_required` | ✅ 抑制（屏上可见） |
| `input_required` | ✅ 抑制（TUI 在等输入） |
| `run_failed` | ❌ 不抑制（异步结果） |
| `run_completed` | ❌ 不抑制（预留） |

---

## 日志与故障排查

日志位于 `~/.opencode-notify/plugin.log`（可通过 `log.file` 自定义）。

| 等级 | 内容 | 用途 |
|------|------|------|
| `error` | 渠道失败、异常 | 生产环境 |
| `warn` | 配置异常、部分失败 | 生产环境 |
| `info` | 渠道启用、通知分发、抑制决策 | 日常运行（默认） |
| `debug` | 全部事件流、DBus 调用详情 | 排查问题 |

```bash
tail -f ~/.opencode-notify/plugin.log
grep "插件已加载" ~/.opencode-notify/plugin.log
grep "\[ERROR\]" ~/.opencode-notify/plugin.log
```

### 常见问题

**Q: 插件未加载？**
确认 `opencode.json` 中 `plugin` 路径正确，指向 `index.ts`。

**Q: 通知没有弹出？**
检查日志是否有 `[event] type=` 行确认事件被监听到；检查渠道 `enabled: true`；检查 Webhook URL 正确性。

**Q: 企业微信/飞书通知失败？**
确认 Webhook URL 有效，网络可达：

```bash
curl -X POST <webhook_url> -H "Content-Type: application/json" \
  -d '{"msgtype":"markdown","markdown":{"content":"**测试**"}}'
```

---

## 项目结构

```
opencode-notify/
├── index.ts                  # 插件入口
├── cli.ts                    # 诊断工具
├── config.ts                 # 配置解析
├── events.ts                 # 事件路由
├── log.ts                    # 日志模块
├── message.ts                # 消息模型
├── session-tracker.ts        # 会话感知抑制
├── terminator-detect.ts      # Terminator 子屏遮挡检测
├── delayed-dispatcher.ts     # 远程延迟推送
├── dispatcher.ts             # 去重分发
├── store.ts                  # 状态存储
├── doc/
│   ├── install.md             # 安装指南
│   ├── features.md            # 功能详解
│   └── de.png                 # 跑马灯效果截图
├── scripts/
│   └── marquee.py             # 屏幕跑马灯脚本
├── senders/
│   ├── types.ts               # Sender 接口
│   ├── system/                # 系统通知
│   ├── screen-flash/          # 屏幕跑马灯
│   ├── custom-webhook.ts
│   ├── wechat-work.ts
│   └── feishu.ts
├── opencode-notify.yaml.example
├── package.json
└── tsconfig.json
```
