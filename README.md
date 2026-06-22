# opencode-notify

opencode 通知插件 — 监听会话关键事件，通过多渠道推送通知到手机、群聊或桌面。

> ⚠️ **个人项目，按需使用** — 主要在 Ubuntu 24.04 (X11) 环境测试，其他平台可能存在问题。
> 如有问题欢迎提 [Issue](https://github.com/luyanfeng/opencode-notify/issues)，不保证及时响应和修复。
>
> **版本发布说明**：本项目不再在 GitHub 发 Release 版本，请关注 npm 包 [@freely01/opencode-notify](https://www.npmjs.com/package/@freely01/opencode-notify) 的最新版本。

## 功能一览

- **多渠道通知**：系统通知 + 屏幕跑马灯 + 企业微信 + 飞书 + 自定义 Webhook
- **会话感知抑制**：用户在 TUI 中操作时，屏上已可见的权限请求类通知自动过滤
- **屏幕遮挡检测**（Terminator）：子屏最大化被遮挡时强制通知，不遗漏
- **远程延迟推送**：任务完成后，对远程渠道额外延迟补偿推送，防止离开时错过
- **去重机制**：同一事件在时间窗口内不重复推送
- **渠道级事件过滤**：每个渠道可独立配置监听哪些事件
- **诊断 CLI**：验证配置、发送测试通知、调试事件流

## 快速开始

### 1. 安装

```bash
npm install -g @freely01/opencode-notify
```

其他安装方式（本地 / Bun 等）见 [doc/install.md](doc/install.md)。

### 2. 注册插件

编辑 `~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["@freely01/opencode-notify"]
}
```

### 3. 配置

首次启动自动生成默认配置 `~/.config/opencode/opencode-notify.yaml`，也可参考项目中的 `opencode-notify.yaml.example`。

```yaml
channels:
  system_message:
    mode: all
  wechat_work:
    mode: delay_only
    webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
  custom_webhook:
    mode: delay_only
    url: "https://gotify.example.com/message"
    headers:
      X-Gotify-Key: "your-app-token"

events:
  - permission_required
  - run_completed
  - run_failed
  - run_cancelled

remote_delay_channels:
  - wechat_work
  - custom_webhook
remote_delay_seconds: 180
```

### 4. 验证

```bash
tail -f ~/.opencode-notify/plugin.log
```

完整配置项参考下文的[配置参考](#配置参考)。

---

## 通知渠道

### 渠道模式

每个渠道通过 `mode` 控制通知时机：

| mode | 行为 |
|------|------|
| `all` | 即时通知 + 参与延迟推送 |
| `delay_only` | 仅通过延迟推送发送（不弹即时通知） |
| `none` | 禁用 |

### 系统消息通知

弹出 OS 原生通知横幅（macOS / Linux / Windows 均支持）。

```yaml
system_message:
  mode: all
```

### 屏幕跑马灯

通知时屏幕四边彩色高亮闪烁，视觉辅助。

```yaml
screen_flash:
  mode: all
  duration: 3.0        # 持续秒数
  speed: 4.0           # 移动速度因子
  intensity: 0.9       # 不透明度 0.0~1.0
```

![跑马灯效果](doc/de.png)

### 自定义 Webhook

通用 HTTP 发送器，支持 Gotify / Bark / PushDeer / Slack / Discord 等。

```yaml
custom_webhook:
  mode: delay_only
  url: "https://gotify.example.com/message"
  method: "POST"
  headers:
    X-Gotify-Key: "your-app-token"
  template: '{"title":"{{title}}","message":"{{body}}","priority":5}'
```

| 参数 | 说明 |
|------|------|
| `url` | Webhook 地址 |
| `method` | `POST` / `GET`，默认 `POST` |
| `headers` | 自定义请求头 |
| `template` | 消息模板，支持 `{{title}}` `{{body}}` `{{event}}` `{{agent}}` `{{sessionID}}` |

### 企业微信

通过群机器人 Webhook 发送 Markdown 消息。

```yaml
wechat_work:
  mode: delay_only
  webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

### 飞书

通过自定义机器人或流程触发器 Webhook 发送消息。

```yaml
feishu:
  mode: delay_only
  webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
```

---

## 远程延迟推送

这是本项目的核心特色。任务完成时先发即时通知（系统消息/跑马灯），3 分钟后如果你仍无操作，对远程渠道（企业微信 / 自定义 Webhook 等）额外补发一条延迟通知。

```yaml
remote_delay_channels:
  - wechat_work
  - custom_webhook
remote_delay_seconds: 180
remote_delay_max_count: 3
```

**取消策略**（延迟期内自动取消，不发送重复通知）：
- 你在 opencode TUI 中产生了操作 → 立即取消
- 你在电脑前读结果（有键盘/鼠标输入）→ 延迟触发时检测到空闲时间短 → 取消
- 你已离开电脑 → 空闲时间持续递增 → 正常发送

---

## 配置参考

### 配置文件位置

默认路径：`~/.config/opencode/opencode-notify.yaml`

### 配置项总览

```yaml
# 通知渠道
channels:
  system_message:
    mode: all
  screen_flash:
    mode: none
    duration: 3.5
    speed: 5.0
    intensity: 0.85
  custom_webhook:
    mode: none
    url: ""
    method: "POST"
    headers: {}
    template: ""
  wechat_work:
    mode: none
    webhook_url: ""
  feishu:
    mode: none
    webhook_url: ""

# 事件订阅
events: [permission_required, run_completed, run_failed, run_cancelled]
dedupe_seconds: 60

# 会话感知抑制
suppress_when_active: true
activity_timeout: 60
suppress_events_when_active:
  - permission_required
session_stale_timeout_ms: 600000

# 远程延迟推送
remote_delay_channels: []
remote_delay_seconds: 180
remote_delay_max_count: 3

# 日志
log:
  level: info
```

---

## 日志与故障排查

日志位于 `~/.opencode-notify/plugin.log`。

```bash
# 实时查看
tail -f ~/.opencode-notify/plugin.log

# 查看插件是否加载成功
grep "插件已加载" ~/.opencode-notify/plugin.log
```

**常见问题：**

**Q: 插件未加载？**  
确认 `opencode.json` 中 `plugin` 路径正确。

**Q: 通知没有弹出？**  
检查日志确认事件是否被监听到；检查渠道 `mode` 不是 `none`；检查 Webhook URL 有效性。

**Q: 远程延迟通知没有收到？**  
检查 `remote_delay_channels` 配置；检查延迟渠道的 `mode` 不是 `none`。延迟触发时日志会输出 `远程延迟: 已推送` 或 `远程延迟: 已取消`，可据此判断。

**Q: Webhook 通知失败？**  
确认 URL 有效且网络可达：

```bash
curl -X POST <webhook_url> -H "Content-Type: application/json" \
  -d '{"msgtype":"markdown","markdown":{"content":"**测试**"}}'
```
