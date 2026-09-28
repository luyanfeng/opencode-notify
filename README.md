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

## 远程控制（手机 → 插件 → opencode）

让手机通过 **Gotify** 或 **ntfy** 远程批准/拒绝权限、回答提问、追加指令或中断任务。插件只做出站连接、**不监听任何端口**，适合公司电脑等无公网入口的场景。ntfy 默认使用**长连接订阅**（实时推送、请求极少），可用 `reply.transport: poll` 退回短轮询。

**用 ntfy 时推荐合并单话题**：手机只订阅一个话题，通知与回复同源。插件发布的通知都带 `tags:[bot_tag]`，订阅端过滤自身消息防回环。权限/提问通知底部渲染**操作按钮**（http 点按即执行；`[复制]` 把命令模板写剪贴板）。

命令（**必须携带通知里的一次性令牌**；无令牌的回复会被静默忽略）：

| 命令 | 作用 |
|------|------|
| `approve <令牌>` / `deny <令牌>` / `always <令牌>` | 允许一次 / 拒绝 / 始终允许（权限） |
| `answer <令牌> <文本>` | 回答提问（⚠️ opencode 2.x 下不可用，见下方说明） |
| `select <令牌> <数字>` | 选该提问第 n 个选项（同义: option/选择/选项；⚠️ 同上） |
| `say <令牌> <文本>` | 向会话追加指令（续接令牌 TTL 内可反复用） |
| `stop <令牌>` | 中断该会话 |
| `status <令牌>` / `help` | 查看待处理 / 帮助 |

> ⚠️ **opencode 2.x：提问无法从手机应答**
>
> 2.x 的提问（`question` 工具）会先建一张 **form**，而插件 ctx **没有暴露 form 应答接口**
> （`session.form.reply` 虽在服务端存在，但不在插件可见的 ctx 域里）。
> 因此 `answer` / `select` 会收到**明确的失败回执**（令牌不消费，TTL 内可重试），
> 而不是静默无响应。提问仍会**正常通知**并渲染按钮，点按后请回电脑处理。
>
> 权限应答（`approve`/`deny`/`always`）、`say`/`stop`/`status` **不受影响**。
> 若你把 opencode 配置里 `question` 权限设为 `ask`，提问会改走权限通道，那时可用 `approve` 应答。

**防重复**：通知里的令牌是**一次性**的（用后即废、默认 30 分钟过期），重复发送不受理；
多开 opencode / 多台电脑共用话题时，令牌含实例前缀，**只有发通知的实例受理**——
无令牌或异主令牌一律静默忽略，不会串答或重复执行。

```yaml
channels:
  ntfy:
    mode: all                           # ntfy（支持按钮）| gotify
    server_url: "https://ntfy.example.com"
    token: "tk_xxxxxxxx"                # 通知与回复共用
    topic: "opencode"                   # 单话题：通知 + 命令/回复
    reply:                              # 回复能力（不配=纯单向通知）
      enabled: true
      # command_topic: "opencode-cmd"   # 省略=合并进 topic（推荐）；填写=分两个话题
      transport: "stream"               # stream（长连接，默认）| poll（短轮询）
      bot_tag: "opencode"               # 插件消息标记（合并模式防回环）
      copy_button: true                 # 提问/完成类附 [复制] 命令模板（仅合并模式）
      receipt_priority: 2               # 回执优先级（发往 topic，低于通知）
      secret: "my-shared-secret"        # 手动命令用；按钮回调免
```

Gotify 用法（无按钮，仅文本命令；读命令用 client token `C...`、发回执用 application token `A...`）与 ntfy 完整选项见 `opencode-notify.yaml.example`。

> ⚠️ **安全**：此通道可批准任意工具（含 shell）在电脑执行，等于远程操作电脑。务必设置 `secret` 或使用受保护话题，且不要把 token/secret 提交到仓库。

> **平台说明**：通知内按钮仅 **ntfy** 支持（Gotify 无此能力）。ntfy Android 体验完整；iOS 的通知按钮默认不在锁屏/通知中心显示（需点开 App），且 `clear` 行为有已知问题——但一次性令牌的防重复在服务端侧始终有效。

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
