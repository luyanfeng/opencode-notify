# 安装指南

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| [opencode](https://opencode.ai) | ≥ 1.15.12 | 插件运行环境 |
| [Node.js](https://nodejs.org) | ≥ 18 | 运行时（opencode 内置 Bun，但 npm 安装需要） |
| npm / bun / pnpm | 任意 | 包管理器 |

## 安装方式

### 方式一：npm 全局安装（推荐）

```bash
npm install -g @freely01/opencode-notify
```

### 方式二：本地路径（开发调试）

```bash
git clone https://github.com/luyanfeng/opencode-notify.git
cd opencode-notify
npm install
```

### 方式三：从 npm registry 安装到项目

如果你使用 Bun 管理 opencode 插件：

```bash
bun add @freely01/opencode-notify
```

---

## 注册插件

编辑 `~/.config/opencode/opencode.json`，在 `plugin` 列表中添加插件引用：

**npm 全局安装：**

```json
{
  "plugin": ["@freely01/opencode-notify"]
}
```

**本地路径（开发调试）：**

```json
{
  "plugin": ["file:///home/<用户名>/path/to/opencode-notify/index.ts"]
}
```

**使用 Bun 本地安装：**

```json
{
  "plugin": ["/home/<用户名>/path/to/opencode-notify/index.ts"]
}
```

> 路径替换为你实际存放项目的目录。

---

## 生成配置文件

首次启动 opencode 时，插件会自动在 `~/.config/opencode/opencode-notify.yaml` 生成默认配置文件。
你也可以手动复制项目中的 `opencode-notify.yaml.example` 到该位置。

---

## 平台依赖

### 系统通知

| 平台 | 依赖 | 备注 |
|------|------|------|
| **macOS** | `osascript`（内置） | 开箱即用 |
| **Linux** | `libnotify-bin` | 桌面发行版通常预装，缺失时 `apt install libnotify-bin` |
| **Windows** | WinRT Native Toast | 开箱即用 |

### 屏幕跑马灯

| 平台 | 依赖 | 备注 |
|------|------|------|
| **Ubuntu 24.04 X11** | Python 3 + PyGObject（GTK 3） | Ubuntu 桌面版内置 |
| **Windows** | PowerShell + .NET WinForms | 系统内置 |
| **macOS** | — | 暂不支持 |

### Terminator 子屏遮挡检测

自动检测，无需额外配置。检测依赖以下工具：

- `xdotool` — `apt install xdotool`
- `xprop` — X11 系统自带

> **注意：** X11 工具在 Wayland 下不可用，检测失败时静默降级，不影响正常通知抑制。

---

## 验证安装

### 方法一：检查加载日志

启动 opencode，查看日志：

```bash
tail -f ~/.opencode-notify/plugin.log
```

出现以下日志行表示插件加载成功：

```
[INFO] 插件已加载, log_level=info, events=[...], suppressActive=true, ...
```

### 方法二：使用诊断 CLI

插件提供了诊断 CLI，可验证配置和渠道是否正常：

```bash
# 查看配置概览
bun run cli.ts --config

# 发送测试通知到所有启用渠道
bun run cli.ts --test

# 指定渠道测试
bun run cli.ts --test --channel wechat_work

# 调试模式（查看详细事件流）
bun run cli.ts --test --debug
```

> 如果全局安装，可使用 `opencode-notify` 替代 `bun run cli.ts`。

---

## 升级

```bash
npm update -g @freely01/opencode-notify
```

升级后重启 opencode 即可加载新版本。

---

## 卸载

1. 从 `~/.config/opencode/opencode.json` 的 `plugin` 列表中移除插件条目
2. 可选：删除配置文件 `~/.config/opencode/opencode-notify.yaml`
3. 可选：删除日志目录 `~/.opencode-notify/`

```bash
npm uninstall -g @freely01/opencode-notify
```

---

## 故障排查

| 现象 | 排查步骤 |
|------|---------|
| 插件未加载 | 检查 `opencode.json` 中 plugin 路径是否正确；检查 `~/.opencode-notify/plugin.log` 是否有错误日志 |
| 系统通知不弹出 | Linux: `which notify-send` 确认已安装；macOS: 检查是否开启了"勿扰模式" |
| Webhook 通知失败 | `curl -X POST <url> -H "Content-Type: application/json" -d '{"test":1}'` 测试网络可达性 |
| 企业微信/飞书通知失败 | 确认 Webhook URL 有效，检查日志中的 HTTP 响应状态码 |
| 跑马灯不显示 | Ubuntu: 确认在 X11 会话下；Windows: 确认 PowerShell 执行策略允许脚本运行 |
