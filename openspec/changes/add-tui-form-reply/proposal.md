## Why

手机上点按「提问（form）」通知的应答**必然失败**，回执为「opencode 2.x 插件 ctx 未暴露表单应答接口，请回电脑处理」。人不在电脑前时，agent 一旦提问，任务就卡死直到回到电脑 — 这是远程控制能力里最后一个洞。

根因**不是** opencode 没有该能力：`session.form.reply` 在服务端 API 与客户端 SDK 中都存在，但**只暴露在 TUI/CLI 插件上下文**（`@opencode/plugin/tui`），而本插件只注册了服务端入口（`@opencode/plugin`），结构性拿不到。opencode 官方支持**同一个包同时导出服务端与 TUI 入口**，且 RPC 提供**双向通道**（服务端 `register().events.emit` → 客户端 `client.rpc(D).events.on`，走同一条 `/api/event` 流），补齐路径已经具备。

## What Changes

- **新增 TUI 侧插件入口** `./tui`（终端进程内运行），订阅服务端派发的应答请求并执行 `context.data.session.form.reply`。
- **新增一个 RPC 定义**（包内共享，id 与包名一致）：服务端注册，提供
  - `methods.confirm`：TUI 完成后回调服务端，用于确认「确实有人处理了」；
  - `events.request`：服务端 → TUI 的应答派发（`formID` / `sessionID` / `answer` / 定位所需信息）。
- **服务端 `replyForm` 改为真实实现**：不再抛错，改为「emit 请求 → 等 `confirm` 回调 → 超时兜底」。
- **超时/无 TUI 时如实告知**：超时（可配，默认数秒）内未收到 `confirm`，回执明确说明「当前没有终端客户端在运行，请回电脑处理」；**令牌不消费**，可重试。
- **成功才消费令牌**：仅当收到 `confirm` 才 `removeByCode`，与既有「执行成功才消费」约定一致。
- **多 TUI 竞争按会话归属收敛**：仅**通知归属的那个会话**所属的 TUI 客户端执行应答；其余 TUI 静默忽略（不重复投递、不产生噪音回执）。
- **通知文案更新**：提问通知不再声明「无法从手机应答」，恢复为正常的 `select` / `answer` 邀请。

## Capabilities

### New Capabilities

- `remote-form-reply`: 手机对提问（form）的应答能被真实投递给宿主并生效；涵盖端到端链路（手机命令 → 服务端 → TUI → 宿主）、无 TUI 运行时的如实告知、多 TUI 竞争按会话归属收敛、以及令牌消费语义（仅成功消费）。

### Modified Capabilities

（无。本项目尚无既有 spec。）

## Impact

**代码**
- `index.ts`：`bridge.replyForm` 由显式抛错改为 RPC 派发 + 回调等待；注册 RPC；文案调整。
- `control/controller.ts`：应答路径接通（`execute` 的 form 分支不再必然失败）；必要时新增「等待确认」参数。
- 新增 `tui.ts`（TUI 入口）与包内共享的 RPC 定义模块（如 `control/rpc.ts` 或根级 `rpc.ts`）。
- `package.json`：`exports` 增加 `"./tui"`；`files` 纳入新文件。

**依赖 / 平台**
- 新增对 `@opencode/plugin/tui` 的类型依赖（devDependency，运行时由宿主解析）。
- 依赖 opencode `GET /api/event` 推送 RPC 事件的能力。

**兼容性 / 行为变化**
- 提问通知文案由「无法从手机应答」改为正常邀请 —— **依赖旧文案的用户预期会变**。
- 终端进程内新增插件实例，**终端侧引入新的故障面**（该插件的异常会影响交互进程）。

**风险（设计阶段必须处理）**
- RPC 事件是**即发即忘**，且订阅是**实时连接**（断开期间的订阅事件会丢失）—— 回调确认机制是需求而非优化。
- 多 TUI 归属判定的实现方式未定，是 design 阶段的主要技术决策。
- 本方案的关键假设（`./tui` 自动加载、RPC 事件双向可达）**部分仅来自官方文档，尚未端到端实测**，须在 design/验证阶段先行证伪。
