# opencode-notify 功能介绍

## 概述

opencode-notify 是一个 opencode 通知插件，监听会话中的关键事件，通过多渠道将通知推送给你。它的设计目标是 **不错过任何重要事件，同时不频繁打扰**。

---

## 1. 多渠道通知

支持多种通知渠道，可同时启用，覆盖不同场景：

| 渠道 | 适用场景 | 要求 |
|------|---------|------|
| 系统通知 | 本地桌面开发，弹 OS 原生通知横幅 | Linux: `notify-send` / macOS: 内置 / Windows: 开箱即用 |
| 屏幕跑马灯 | 人不在屏幕前时，通过余光感知有通知（屏幕四边高亮闪烁） | Linux: Python + GTK / Windows: PowerShell + WinForms |
| 企业微信 | 团队协作，通知发到企微群 | 企微群机器人 Webhook |
| 飞书 | 团队协作，通知发到飞书群 | 飞书自定义机器人 Webhook |
| 自定义 Webhook | 对接任意 HTTP 服务（Gotify / Bark / Slack / Discord 等） | HTTP 服务地址 |

**典型用法**：系统通知做桌面提醒 + 企业微信/飞书做远程推送，同时开启。

---

## 2. 渠道级事件过滤

每个渠道可以独立配置监听哪些事件，实现"重要走手机，一般看桌面"的分流效果。

```yaml
# 系统通知：所有事件都弹窗
system_message:
  enabled: true

# 企业微信：只推送任务失败，减少群消息骚扰
wechat_work:
  enabled: true
  events:
    - run_failed
```

---

## 3. 会话感知抑制

### 解决的问题

当你在 opencode TUI 中操作时，屏幕上的信息是可见的，此时弹出系统通知是冗余的。比如：

- Agent 正在请求权限 → 权限弹窗就在屏幕上，不需要再弹系统通知
- Agent 在等你输入 → TUI 明确在等输入，不需要再提醒

### 实现方式

插件追踪每个会话的操作时间戳，如果某个会话最近有用户操作（输入消息、回应权限、执行命令等），则按事件类型选择性过滤通知。

### 抑制规则（默认）

| 通知事件 | 活跃时行为 | 理由 |
|---------|:---------:|------|
| `permission_required` | ✅ 抑制 | 权限弹窗就在屏幕上，看得见 |
| `input_required` | ✅ 抑制 | TUI 明确在等输入 |
| `run_failed` | ❌ 不抑制 | 异步结果，人可能走开了 |
| `run_completed` | ❌ 不抑制 | 同上 |

### 配置

```yaml
suppress_when_active: true           # 开启智能抑制
activity_timeout_ms: 15000           # 15 秒无操作视为不活跃
suppress_events_when_active:         # 活跃时抑制哪些事件
  - permission_required
  - input_required
```

---

## 4. Terminator 子屏幕遮挡检测

### 背景故事

Terminator 是一款支持在同一窗口中分多个子屏幕的终端模拟器。它的 `Ctrl+Shift+X`（最大化终端）功能可以把某个子屏幕放大到全窗口，**其他子屏幕被完全遮挡**。

这是一个非常实用的功能，特别是需要在多个任务间切换时。但这也带来了一个通知问题。

### 场景复现

```
┌─────────────────────┬──────────────────────┐
│  左侧：opencode A   │  右侧：opencode B    │
│  (配置数据库迁移)    │  (开发新功能)         │
└─────────────────────┴──────────────────────┘
```

你在左侧操作 opencode A，此时 A 处于活跃状态。然后你按 `Ctrl+Shift+X` 把右侧子屏幕最大化：

```
┌──────────────────────────────────────────┐
│       右侧：opencode B (全屏)              │
│  左侧 opencode A 被完全遮住                 │
│  但 A 的"会话活跃"状态还在                   │
└──────────────────────────────────────────┘
```

此时 opencode A 收到一个权限请求：
- **会话感知抑制**认为：A 最近有操作 → 活跃 → 屏幕可见 → 不通知
- **实际**：A 被右侧全屏遮住了，**你看不到权限弹窗**
- **结果**：**你错过了这个请求**

### 解决方案

插件通过两级检测识别遮挡场景：

```
事件被活跃抑制
  ↓
① Terminator 窗口是当前 X 活跃窗口？     ← xdotool + xprop (WM_CLASS)
  否 → 用户在别的应用中（浏览器/IDE）→ 强制通知
  ↓ 是
② 用户聚焦的是哪个子屏？               ← DBus get_focused_terminal
  聚焦 == 本屏 → 不遮挡（用户正在看这个屏）
  聚焦 != 本屏 → 遮挡（用户在另一个子屏上）
```

### 友好体验

| 场景 | 行为 |
|------|------|
| 本屏聚焦操作 | ✅ 正常抑制，不打扰 |
| 用户在另一个子屏上（分屏或最大化） | ✅ 强制通知（用户可能看不到本屏内容） |
| 不在 Terminator 中（普通终端、SSH 等） | ✅ 正常抑制，不受影响 |
| Terminator 窗口不活跃（切到浏览器） | ✅ 强制通知 |
| 检测工具未安装 | ✅ 静默降级，正常抑制 |

**不需要任何配置**，在 Terminator 中自动生效。

### 技术原理

- 利用 Terminator 在每个子终端中设置的 `$TERMINATOR_UUID` 环境变量确定身份
- **第一级**: 通过 `xprop -id $(xdotool getactivewindow) WM_CLASS` 检测 Terminator 窗口是否是当前 X 活跃窗口
- **第二级**: 通过 DBus 的 `get_focused_terminal` 获取当前聚焦子屏的 UUID，与本屏对比
- **判断**: 只要用户不在本屏上操作，就视为遮挡并强制通知

### 已知问题

当前 Terminator 版本未暴露 `get_maximized_terminal` DBus 接口（Terminator 内部没有为子屏窗口注册独立的 DBus 对象），因此**无法区分"分屏可见"和"最大化遮挡"**：

| 场景 | 期望 | 实际行为 | 原因 |
|------|:----:|:--------:|------|
| 分屏，切到另一个子屏（未最大化） | 不通知（另一个屏也可见） | ❌ 通知 | 无法判断是否最大化 |
| 最大化另一个子屏，本屏被隐藏 | 通知 | ✅ 通知 | 聚焦 != 本屏 → 通知 |

**影响：** 即使另一个子屏在分屏模式下可见，切换过去也会触发通知。如果你经常在分屏间切换且不想被干扰，可调整以下配置缓解：

```yaml
# 延长活跃超时，让会话更快进入"不活跃"状态
# 这样即使切屏，等到会话变成不活跃后抑制自动消失
activity_timeout_ms: 5000       # 5 秒（默认 15 秒）
# 或关闭某些事件的活跃抑制
suppress_events_when_active: [] # 空列表 = 不抑制任何事件
# 或完全关闭会话感知抑制
suppress_when_active: false     # 所有事件都通知
```

---

## 5. 屏幕跑马灯

### 解决的问题

系统通知横幅可能不够醒目——尤其是当你离开座位或专注于另一块屏幕时。屏幕跑马灯在通知时将屏幕四边点亮，通过余光即可感知有通知到来。

### 实现

- **Ubuntu 24.04 X11**: 使用 Python + PyGObject(GTK 3) 创建透明覆盖窗口，60fps 彩色灯光沿四边循环运动
- **Windows**: 使用 PowerShell + .NET WinForms 创建 8px 宽的彩色闪烁边框，中间完全透明可点击穿透

### 配置

```yaml
screen_flash:
  enabled: true
  duration: 3.0       # 持续秒数（默认 3.0）
  speed: 4.0          # 移动速度因子（默认 4.0）
  intensity: 0.9      # 不透明度 0.0~1.0（默认 0.9）
```

---

## 6. 远程延迟推送

### 解决的问题

通知发到手机或群聊时，存在一个困境：

- **立即推送**：用户可能只是去倒杯水，1 分钟就回来了，手机一直在震
- **延迟推送**：用户真的走了，但通知发得太晚

### 方案

正常通知**照常发送**（该发就发），同时为指定渠道额外调度一个"延迟补偿"通知：

```
事件到来
  ↓
所有启用渠道 → 立即发送正常通知
  ↓
remote_delay_channels 中的渠道 → 等 N 秒
  ↓
期间用户回来了（操作 TUI）→ 取消延迟通知
  ↓
超时了用户还没回来 → 再发一次（延迟补偿）
  ↓
最多重复 M 次，每次间隔 N 秒
```

### 典型配置

```yaml
remote_delay_channels:        # 哪些渠道需要延迟补偿
  - wechat_work
  - feishu
remote_delay_seconds: 60      # 等 60 秒
remote_delay_max_count: 3     # 最多重复 3 次
```

### 友好体验

| 场景 | 行为 |
|------|------|
| 用户在电脑前操作 | 正常通知 → 看到了 → 延迟取消 → 手机不震 |
| 用户离开倒水（1 分钟） | 正常通知（没看到）→ 60 秒后手机再震一次 |
| 用户出门午饭（30 分钟） | 60 秒、120 秒、180 秒各震一次，最多 3 次 |

---

## 7. 去重

同一事件（`agent:event:sessionID`）在时间窗口内只发送一次，避免重复骚扰。

```yaml
dedupe_seconds: 60    # 60 秒内不重复发送
```

---

## 8. 灵活的事件订阅

只订阅你关心的事件类型：

| 事件 | 说明 |
|------|------|
| `permission_required` | Agent 需要用户授权（推荐开启） |
| `input_required` | Agent 等待用户输入（推荐开启） |
| `run_failed` | 任务执行失败（推荐开启） |
| `run_completed` | 任务完成（暂未实现） |

```yaml
events:
  - permission_required
  - input_required
  - run_failed
```

---

## 9. 日志系统

四级日志，满足从日常监视到深度排查的各种需求：

| 等级 | 内容 | 建议场景 |
|------|------|---------|
| `error` | 渠道发送失败、持久化异常 | 生产环境，只看报错 |
| `warn` | 配置异常、部分失败 | 生产环境，关注潜在问题 |
| `info` | 渠道启用、通知分发、抑制决策 | 日常运行（默认） |
| `debug` | 事件流细节、去重命中、DBus 调用详情 | 排查问题 |

---

## 完整的典型配置

```yaml
# 本地桌面弹通知
system_message:
  enabled: true

# 屏幕跑马灯视觉提醒
screen_flash:
  enabled: true
  duration: 3.0
  speed: 4.0
  intensity: 0.9

# 远程推送到手机
wechat_work:
  enabled: true
  webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"

# 只订阅关心的事件
events:
  - permission_required
  - input_required
  - run_failed

# 重要事件延迟补偿推送到微信
remote_delay_channels:
  - wechat_work
remote_delay_seconds: 60
remote_delay_max_count: 3

# 日志日常 info，出问题时切 debug
log:
  level: info
```
