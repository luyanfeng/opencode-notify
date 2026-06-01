# 进度日志

## 2026-05-29 Phase 0: 研究与规划

### 完成
- 分析 opencode 插件 API（Plugin/Hooks 类型定义）
- 确认 opencode event hook 可用作通知事件源
- 编写 plan.md, task_plan.md, findings.md

---

## 2026-05-30 Phase 1: 基础框架 ✅ 完成

### 完成
- 项目初始化: package.json, tsconfig.json, 依赖安装
- 插件入口 `index.ts`: 正确实现 Plugin 签名
- 配置模块 `config.ts`: 配置解析 (options → env → 默认值)
- 消息模型 `message.ts`: Message 类型 + 格式化
- 事件路由 `events.ts`: 事件映射 + 消息构造
- 去重存储 `store.ts`: 内存 Map + JSON 持久化
- 分发器 `dispatcher.ts`: 去重 → 并发发送 → 标记
- 系统通知 `senders/system.ts`: macOS/Linux/Windows
- TypeScript 编译零错误

### 端到端测试
插件加载到真实 opencode 实例并验证通过：
- ✅ `permission.asked` → 系统通知弹出
- ✅ `question.asked` → 系统通知弹出
- ✅ `session.idle` → 系统通知弹出
- ❌ `permission.ask` hook 不触发（不经过此路径）
- ❌ `permission.updated` 不存在（事件名是 `permission.asked`）

### 文件清单
```
index.ts                     # 插件入口
config.ts                    # 配置解析
message.ts                   # 消息模型
events.ts                    # 事件路由
dispatcher.ts                # 去重分发
store.ts                     # 状态存储
senders/types.ts             # Sender 接口
senders/system.ts            # 系统通知
package.json / tsconfig.json # 项目配置
```

### 新增: 活跃抑制（TUI 激活时不通知）
通过事件总线检测用户操作，30s 内有交互则跳过通知。
- ✅ 跨平台（不依赖桌面 API，SSH 远程也生效）
- ✅ 默认开启，可配置关闭
- ✅ 零外部依赖，~10 行逻辑
- ✅ TypeScript 编译零错误

---

## Phase 2: 消息渠道 ✅ 全部完成

### 🟢 已完成
- 自定义 Webhook `senders/custom-webhook.ts` — 通用 HTTP POST
  - 支持模板插值 `{{title}} {{body}} {{event}} {{agent}} {{sessionID}}`
  - 支持自定义请求头
  - JSON 安全转义
  - ✅ Gotify 实测通过 (HTTP 200)
- 企业微信 `senders/wechat-work.ts`
  - Markdown 格式消息
  - 包含标题、正文、会话ID
- 飞书 `senders/feishu.ts`
  - 卡片消息格式 (interactive)
  - 标题 + 正文 + 分割线 + 脚注
- 配置分离到独立 YAML 文件
  - `~/.config/opencode/opencode-notify.yaml`
  - 加载优先级: YAML > plugin options > 环境变量 > 默认值
  - 每项配置均有详细中文注释
- `js-yaml` 依赖（零自身依赖）

### 📊 里程碑进度
| 渠道 | 状态 | 验证 |
|------|:----:|:----:|
| 系统通知 | ✅ | 实际 opencode 事件驱动测试通过 |
| 自定义 Webhook (Gotify) | ✅ | curl + 插件内调用均 HTTP 200 |
| 企业微信 | ✅ | 已实现 |
| 飞书 | ✅ | 已实现 |

**Phase 2 全部完成 ✅**

---

## Phase 3: 完善体验

### 🟢 已完成
- README.md — 安装说明、配置详解、各渠道用法、事件映射、常见问题
- 诊断工具 `cli.ts` — check / test / log / info 四个子命令，所有渠道测试通过

### 🔴 待定
- GitHub Actions 发布

### ⚫ 已取消
- 配置向导（YAML 注释 + check 命令已够用）

---

## Phase 4: 远程延迟推送

**设计**:
- 正常通知不受影响，渠道该发就发
- `remote_delay_channels` 列表中的渠道在正常通知后再补一次延迟推送
- 用户活跃回到 TUI → 取消该会话所有待发延迟通知
- 超时后发送，最多重复 `remote_delay_max_count` 次

### 方案确认（2026-06-01）
- `remote_delay_channels`: 全局列表，列出哪些渠道需要额外延迟推送
- `remote_delay_seconds`: 延迟秒数（默认 60）
- `remote_delay_max_count`: 最多重复次数（默认 3）
- 延迟推送使用渠道级事件过滤（与正常通知一致的 FilteredSender）
- `DelayedDispatcher` 模块独立于 `Dispatcher`，不参与去重
- 用户活跃事件 (`USER_ACTIVITY_EVENTS`) + `session.deleted` 触发取消

---

## Phase 5: 日志体系重构

### 已完成
- log.ts 重写为等级式日志（error/warn/info/debug + 自定义路径）
- config: `debug_log` → `log.level` + `log.file`
- 全模块添加适当等级的日志覆盖（dispatcher / store / session-tracker 等）
- CLI 适配（读取配置的 log.file / 显示 log.level）

---

## Phase 6: 终端子屏幕遮挡检测

### 设计
当用户在 Terminator 中最大化某个子屏时（Ctrl+Shift+X），其他子屏中的 opencode 会话被遮挡。
启用 `force_notify_terminals: [Terminator]` 后，插件通过 DBus 检测当前焦点终端 UUID，
与本进程 `$TERMINATOR_UUID` 比较。不一致 → 强制发送通知（忽略会话感知抑制）。

### 检测策略（依次回退）
1. `busctl`（systemd 自带，Ubuntu 预装）
2. `python3 -c "import dbus"`（python3-dbus）
3. `gdbus call`（GLib）
4. `xdotool getactivewindow getwindowclassname`（回退，仅判断窗口类）

---

## Phase 5: 日志体系重构

**设计**:
- 将 `debug_log: boolean` 替换为 `log.level` + `log.file`，支持四级日志
- 所有文件的关键路径添加适当的 `error()` / `warn()` / `info()` / `debug()` 调用

### 日志等级

| 等级 | 数值 | 说明 |
|------|:----:|------|
| `error` | 0 | 系统无法正常运行或功能不可用 |
| `warn` | 1 | 潜在问题，不影响核心功能 |
| `info` | 2 | 正常运行状态变化（默认） |
| `debug` | 3 | 详细事件流，仅排查时开启 |

### 改动文件

| 文件 | 改动 |
|------|------|
| `log.ts` | 重写为等级式日志，新增 `configureLog`/`error`/`warn`/`info`/`debug` |
| `config.ts` | `debug_log` → `log.level` + `log.file` |
| `index.ts` | 全部 `log()` 替换为等级函数，`enableDebug()` → `configureLog()` |
| `dispatcher.ts` | 添加去重命中 `debug`、分发 `info`、失败 `error`/`warn` |
| `delayed-dispatcher.ts` | 替换 `log()` 为等级函数，`console.error` → `error()` |
| `store.ts` | 状态文件读取失败 `warn`、持久化失败 `error` |
| `session-tracker.ts` | 销毁时清理 `warn` |
| `cli.ts` | 日志文件路径从配置读取，显示日志等级 |
