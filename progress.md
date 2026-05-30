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
