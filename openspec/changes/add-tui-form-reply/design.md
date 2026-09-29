## Context

见 `proposal.md — Why`。设计所需的现状约束：

- 本插件当前**只有一个入口**：包名 `.` → `index.ts`（服务端插件）。`package.json` 的 `exports` 为 `{ ".": "./index.ts", "./cli": "./cli.ts" }`。
- 服务端 ctx **没有** form 域；TUI 侧 `context.data.session.form.reply(input, location?)` 存在，入参 `SessionFormReplyInput = { sessionID, formID, answer }`，`answer` 形如 `{ q0: "选项提交值" }`。
- 服务端 RPC（`ctx.rpc.register`）与客户端订阅（`context.client.rpc(D).events.on`）走同一条 `/api/event` 事件流；服务端注册对象提供 `events.emit`。
- 服务端事件 `form.created` 的载荷含可选 `location?: { directory, workspaceID }`（来源：`@opencode/schema/form` 事件定义）。
- 既有远程控制链路的约定必须保持：一次性令牌 `oc-<实例>-<随机>`、实例前缀隔离、**执行成功才消费令牌**、失败**不消费**、失败回执写明原因、多进程下无归属命令静默。
- `control/` 层只依赖 `OpencodeBridge` 窄接口（`replyForm` 签名即 `SessionFormReplyInput`），不直接依赖 opencode 类型包。

## Goals / Non-Goals

**Goals:**
- 打通「手机 → 服务端 → 终端客户端 → 宿主」的 form 应答链路，且**投递结果可判定**（成功/失败/超时都有明确结论）。
- 多终端在线时**只有一个**客户端执行投递，其余静默。
- 无终端客户端可用时，用户得到**如实**反馈而非石沉大海。
- 不破坏既有服务端能力（通知常驻、跨客户端去重、权限应答）。

**Non-Goals:**
- 不改用 TUI-only 架构（见 `doc/v2-plugin-form-mechanism.md` 第 5 节）。
- 不包装/替换 `question` 工具（会破坏本机 TUI 弹窗交互）。
- 不处理 `opencode run` 无头模式下宿主的自动 dismiss（宿主行为，非本插件可控）。
- 不引入新的外部依赖或网络服务。

## Decisions

### D1. 通道：服务端注册 RPC，TUI 订阅其事件

服务端通过 `ctx.rpc.register(<definition>, handlers)` 注册，TUI 通过 `context.client.rpc(<definition>)` 获得子客户端并 `events.on(...)` 订阅。

定义（包内共享模块，服务端与 TUI 共用同一 definition 对象）：
- `id`：与包语义一致（如 `opencode-notify.form`）。
- `events.request`：载荷含 `{ formID, sessionID, answer, locationDirectory? }`。
- `methods.confirm`：TUI 完成后回调，载荷含 `{ formID, ok, failureKind? }`，服务端据此判定结果。

**为什么不用「落盘待办 + TUI 轮询」**：轮询引入固定延迟与新的文件生命周期/竞态，而事件通道是官方既有机制，且回调确认让结果可判定。轮询方案留作通道不可用时的备选（见 Open Questions）。

**为什么不用「TUI 只订阅 `/api/event` 自行判断」**：那需要 TUI 侧重建一套「哪些提问待处理」的状态；由服务端持有 pending 注册表（已存在）更贴合既有架构。

### D2. 归属判定：位置优先，会话次之，先到先得兜底

多终端竞争按「通知归属」收敛，判定顺序：

1. **位置匹配（主判据）**：请求携带 `locationDirectory` 时，仅**有效位置等于该目录**的 TUI 参与。
   有效位置 = `context.location?.directory ?? context.data.location.default().directory`。
2. **会话持有（次判据）**：请求未携带位置时，仅**本地已加载该会话**的 TUI 参与
   （先 `data.session.sync(sessionID)`，再 `data.session.get(sessionID) !== undefined`）。
3. **先到先得（兜底）**：若仍有多个 TUI 同时满足（例如两个窗口在同一位置），第一个成功调用 `form.reply` 的胜出；
   其余收到 `FormAlreadySettledError` 时**静默**（不重复投递、不回执）。

**理由**：位置是终端客户端的天然粒度，且服务端能从 `form.created` 事件直接拿到；
会话持有粒度更细但在同一位置多窗口时会同时命中，故必须保留先到先得的兜底，否则无法收敛。

**备选**：仅用会话持有 —— 同一位置多窗口时无法收敛；仅用位置 —— 同一位置多窗口时无法收敛；两者叠加 + 兜底是唯一能保证收敛的组合。

### D3. 结果判定：回调确认 + 超时如实告知

服务端 `replyForm` 的流程：

1. 校验入参（`formID`、`sessionID`、`answer` 非空），不合法 → 抛错（由上层转成失败回执）。
2. 置一个待确认记录后 `emit("request", …)`。
3. 等待 `confirm` 回调，超时上限为**可配置**（默认值见 Open Questions）。
4. 结果：
   - 收到 `ok: true` → 返回成功（上层据此消费令牌）；
   - 收到 `ok: false` → 抛出携带 `failureKind` 的错误（上层据此回执原因，**不消费令牌**）；
   - 超时 → 抛出「当前没有终端客户端在运行」类错误（**不消费令牌**）。

**为什么必须回调**：RPC 事件是**即发即忘**，且订阅是**实时连接**（断开期间的订阅事件丢失）。
没有回调就无法区分「没人处理」与「已处理」，也就无法满足 spec 的「如实告知」与「令牌仅成功后消费」。

### D4. 无 TUI 的判定就是「超时」

不做「先探测有没有 TUI 在线」的额外机制 —— 探测本身也需要通道，且探测通过后目标也可能立刻消失。
统一以「超时未确认」作为「无可用终端客户端」的判据，语义简单且无 TOCTOU 窗口。

### D5. 服务端侧改动保持在窄接口之内

`replyForm` 由「显式抛错」改为「D2/D3 的实现」。`control/` 层无改动：
`ControlController` 仍在 `execute` 里调 `bridge.replyForm(...)`，成功则消费令牌、失败则保留并回执原因 —— 既有约定复用。

### D6. 通知文案

提问通知的应答邀请改为正常文案，删除「无法从手机应答」类声明（满足 spec 最后一条）。

## Risks / Trade-offs

- [**`./tui` 是否真能被 CLI 自动加载，仅来自官方文档，本机未做对照实验**] → 列为 apply 阶段的**第一个验证任务**；若假设不成立，回退到「在 `cli.json` 显式登记」或改用轮询方案（见 Open Questions）。这是整个方案的前置门槛。
- [**RPC 事件订阅是实时连接，TUI 刚启动尚未订阅完成时会漏事件**] → 由超时兜底为「如实告知」，用户可重试（令牌未消费）；不引入补发机制（会与 pending 生命周期耦合）。
- [**归属判定依赖 `context.data.session` 的加载语义（是否默认加载全量会话）**] → apply 阶段实测；若默认全量加载导致次判据失效，则仅依赖位置匹配 + 先到先得兜底，与 D2 的收敛性结论一致。
- [**终端进程内新增插件实例，其异常会影响交互进程**] → TUI 入口保持最小职责（只做订阅 + 应答 + 回调），处理器内不使用会抛出到事件循环外的写法；失败路径一律转成 `confirm(ok:false)`。
- [**两个终端同时在线仍可能竞争**] → 先到先得兜底 + 静默处理 `FormAlreadySettledError`，不会产生重复投递或噪音回执。
- [**超时过长会让用户等待，过短会误报「无终端」**] → 默认值取保守小值（见 Open Questions），并作为配置项暴露。

## Migration Plan

- **兼容性**：纯增量。服务端入口与既有配置不变；新增 `./tui` 导出后由 CLI 自动加载（若 D6 假设成立）。
- **回滚**：移除 `exports["./tui"]` 与 `tui.ts`，并把 `replyForm` 恢复为显式抛错即可回到当前行为。
- **部署**：`opencode service restart`（服务端插件）+ 重启终端客户端（TUI 插件）。
- **验证顺序**（apply 阶段）：
  1. 先验证 `./tui` 自动加载与 `ctx.rpc` 事件双向可达（前置门槛，不通过则整体方案需改）；
  2. 再验证归属过滤与超时兜底；
  3. 最后做真实手机端到端验收。

## Open Questions

1. **超时默认值**：2s / 5s / 8s？倾向 5s（人不在电脑前时不敏感，但也不至于让用户以为卡死）。可在 apply 阶段按实测手感定，不影响 spec。
2. **归属次判据的加载语义**：`context.data.session` 是否默认加载该位置全部会话，需实测；不影响 spec（spec 只要求「仅归属方处理」，实现手段可换）。
3. **是否让位置缺失时回退为「所有 TUI 竞争」**：当前设计选择「位置缺失则用会话持有判据」，若实测两者都不可用，再决定是回退竞争还是如实报错。
4. **轮询方案作为备选**：若 RPC 事件通道实测不可用，改用「服务端落盘待办 + TUI 定时拉取」，spec 的行为契约不变，仅 design 的实现章节需要改写。
