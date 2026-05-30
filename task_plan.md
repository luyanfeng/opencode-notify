# opencode-notify 任务计划

## 阶段状态
- 🔴 未开始
- 🟡 进行中
- 🟢 已完成
- ⚫ 已取消

---

## Phase 0: 研究与规划 ✅
**目标**: 充分了解参考项目和 opencode 插件机制，制定可行方案

| 步骤 | 状态 | 可交付物 |
|------|------|---------|
| 0.1 分析 opencode 插件系统 | 🟢 | findings.md |
| 0.2 分析 opencode 插件系统 | 🟢 | findings.md 第2节 |
| 0.3 比对差异 & 可行性分析 | 🟢 | findings.md 第3-4节 |
| 0.4 编写计划文档 | 🟢 | plan.md |

---

## Phase 1: 基础框架 ✅ 已完成

**目标**: 插件加载成功，收到 opencode 事件后弹出系统通知
**实际成果**: 权限请求(`permission.asked`/`question.asked`)和会话空闲(`session.idle`)均可弹出系统通知

| 步骤 | 状态 | 文件 |
|------|------|------|
| 1.1 项目初始化 (package.json, tsconfig) | 🟢 | 项目结构 |
| 1.2 插件入口 (Plugin 签名) | 🟢 | index.ts |
| 1.3 配置解析模块 (Config) | 🟢 | config.ts |
| 1.4 消息模型 (Message) | 🟢 | message.ts |
| 1.5 事件路由模块 (Events → Message) | 🟢 | events.ts |
| 1.6 状态存储 (Store) | 🟢 | store.ts |
| 1.7 去重分发器 (Dispatcher) | 🟢 | dispatcher.ts |
| 1.8 系统通知发送器 (macOS/Linux/Windows) | 🟢 | senders/system.ts |
| 1.9 端到端集成测试 | 🟢 | 实际 opencode 验证通过 |
| 1.10 活跃抑制（TUI 激活时不通知） | 🟢 | index.ts + config.ts |

### Phase 1 实测发现
- 权限请求事件是 `permission.asked`（不是 `permission.updated` 也不是 `permission.ask` hook）
- `tool` 属性是对象，需取 `tool.name` 或 `tool.type`
- `question.asked` 也承载权限请求，需要处理
- `session.status` 和 `session.idle` 均可感知空闲

---

## Phase 2: 消息渠道 ✅ 全部完成

| 步骤 | 状态 | 可交付物 |
|------|------|---------|
| 2.1 企业微信通知 | 🟢 | senders/wechat-work.ts |
| 2.2 飞书 Webhook 通知 | 🟢 | senders/feishu.ts |
| 2.3 自定义 Webhook 通知 | 🟢 | senders/custom-webhook.ts（支持 Gotify 等，含模板插值） |
| 2.4 Gotify 实际测试 | 🟢 | curl + 插件直连均 HTTP 200，通知推送成功 |
| 2.5 配置分离到 YAML | 🟢 | ~/.config/opencode/opencode-notify.yaml |
| 2.6 配置项详细文档 | 🟢 | YAML 文件内含完整注释说明 |

**里程碑**: 至少 2 个渠道测试通过（系统通知 ✅ + 自定义 Webhook ✅ + 已实现全部渠道）

---

## Phase 3: 完善体验

| 步骤 | 状态 | 可交付物 |
|------|------|---------|
| 3.1 可选配置向导 (命令工具) | ⚫ 已取消 | YAML 注释 + check 命令已够用 |
| 3.2 调试/诊断模式 | 🟢 | cli.ts (check / test / log / info) |
| 3.3 README + 使用文档 | 🟢 | 文档 |
| 3.4 GitHub Actions 发布流程 | 🔴 | CI/CD |

**里程碑**: v1.0.0 发布

---

## 决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-05-29 | TypeScript + Bun 实现 | opencode 原生支持 TS 插件，Bun 是官方推荐运行时 |
| 2026-05-29 | 插件选项通过 opencode.json 传入 | 标准做法，用户无需额外配置文件 |
| 2026-05-29 | 使用 event hook 而非专用 hook | 总线事件统一处理，覆盖更广 |
| 2026-05-30 | permission.asked 走 event 总线（实测） | 不是 permission.updated，也不是 permission.ask hook |
| 2026-05-30 | 同时处理 permission.asked + question.asked | 两种事件都会触发权限通知 |
| 2026-05-30 | 活跃抑制配置 suppress_when_active 默认开启 | 用户操作 TUI 时自动跳过通知，跨平台无外部依赖 |
| 2026-05-30 | 活跃检测基于事件总线（方案C）而非窗口焦点 | 跨平台 + SSH 远程兼容，~10行代码实现 |
| 2026-05-30 | 新增 js-yaml 依赖用于 YAML 配置解析 | js-yaml 零自身依赖，YAML 文件比 opencode.json tuple 更适合管理配置 |
| 2026-05-30 | 配置从 opencode.json 迁移到独立 YAML 文件 | 解耦插件配置和 opencode 全局配置，编辑更安全 |
| 2026-05-30 | suppress_when_active 默认改为 false（用户要求） | 始终通知，不因活跃度抑制 |
