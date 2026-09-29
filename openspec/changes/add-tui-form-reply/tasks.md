## 1. 前置验证（门槛：不通过则整体方案需改）

- [x] 1.1 新增最小 `tui.ts`（仅 `export default Plugin.define({ id, setup })` 且 `setup` 只写一行 `console.log`），在 `package.json` 的 `exports` 加 `"./tui"`，重启终端客户端后确认该行被打印 —— 验证「暴露 `./tui` 的包由 CLI 自动加载」这一官方承诺在本机成立
- [x] 1.2 在服务端注册一个临时 RPC（含一个 event 与一个 method），在 `tui.ts` 里 `context.client.rpc(D).events.on(...)` 订阅并用 `methods` 回调服务端，确认「服务端 emit → TUI 收到 → TUI 回调 → 服务端收到」闭环成立 —— 验证 RPC 事件双向通道可用
  - 结果：✅ 方向A（TUI 调服务端 `echo`）成功；方向B（服务端 `emit("pong")` → TUI 收到 → TUI 调服务端 `ack`）闭环成功。
  - ⚠️ 附带发现（必须由实现兜住）：① 同一 RPC 会被多个实例重复注册（探针放在单例选举之外时观察到 3 次注册）→ 注册须置于单例 `activate` 内；② 事件存在**重放**（同一 `nonce` 在不同时刻被反复收到）→ 归属过滤、先到先得兜底、已结算静默是必需项。
- [x] 1.3 实测 `context.location?.directory` 与 `context.data.location.default()` 的取值，以及 `context.data.session.get(sessionID)` 是否需要先 `sync` —— 记录归属判定（design D2）所需的真实可用判据
  - 结果：`context.location?.directory = "/home/lyf"`（与 `data.location.default().directory` 一致）→ **位置判据可用**；`session.list()` 返回 1 条（**非全量加载**）→ 会话持有判据可用但要靠 `sync`；`sync(不存在的会话)` 抛 `Session not found` → 次判据须容错。
- [x] 1.4 若 1.1 或 1.2 不成立：停止实现并向用户报告，按 design「Open Questions 4」评审改用 `cli.json` 显式登记或轮询备选方案
  - 结果：1.1、1.2 均成立，**无需启用备选方案**。本项作为条件分支落空（不适用）。

## 2. RPC 契约（包内共享）

- [x] 2.1 新增包内共享的 RPC 定义模块（服务端与 `tui.ts` 共用同一 definition 对象），定义 `events.request` 载荷 `{ formID, sessionID, answer, locationDirectory? }` 与 `methods.confirm` 载荷 `{ formID, ok, failureKind? }` —— 验证 `npx tsc --noEmit` 通过
  - 结果：新增根级 `form-reply-rpc.ts`（放根级而非 `control/`：它 import `@opencode/plugin/rpc`，保持 design D5 的「control/ 不耦合 opencode 类型包」）。`TSC=0`。
- [x] 2.2 服务端注册该 RPC 与 `confirm` 处理器，`confirm` 按 `formID` 唤醒对应的等待者 —— 验证：构造一次 emit 后由测试代码手动调用 `confirm`，服务端对应等待者被唤醒且结果正确
  - 结果：新增 `form-reply-bridge.ts`（`FormReplyBridge`）；`index.ts` 在单例 `activate` 内 `register()`、`deactivate` 内 `dispose()`。新增 `scripts/form-reply-bridge-smoke.ts`（27 断言全过）覆盖「注册→成功确认→唤醒」。

## 3. 服务端应答链路

- [x] 3.1 实现「待确认注册表」：`replyForm` 前登记，收到 `confirm` 或超时后清除；同 `formID` 重复调用时复用既有等待者而非叠加 —— 验证：连续两次调用同一 `formID` 只产生一次 emit，且两次调用都得到同一结果
  - 结果：`waiters: Map<formID, Waiter>` 天然实现复用；冒烟第 4 组验证「只派发一次 emit / 两次调用同结果」。
  - ⚠️ 顺带修掉两处**测试跑出的真实缺陷**：① `createWaiter` 原实现存在 TDZ（`timer` 在闭包中先于初始化被引用）导致等待者登记失败；② 派发 `emit` 抛错时原实现先 `settle` 再 `throw`，产生 **unhandledRejection**；改为 `cancelWaiter`（只清理不结算）。
- [x] 3.2 改写 `index.ts` 的 `bridge.replyForm`：校验入参 → 登记 → `emit("request")` → 等待 `confirm`（超时默认 5s，可作为配置项）→ 按 `ok:true` 返回成功 / `ok:false` 抛出携带 `failureKind` 的错误 / 超时抛出「当前没有终端客户端在运行」错误 —— 验证：三种结果各自可复现，且抛出的错误信息与 design D3 一致
  - 结果：新增配置项 `form_reply_timeout_ms`（默认 5000，`config.ts` 的 `PluginConfig`/`DEFAULT_CONFIG`/`resolveConfig` 三处同步）；`replyForm` 改为调 `FormReplyBridge.request`。冒烟覆盖成功/`ok:false`/超时三种结果的错误类型与文案。
- [x] 3.3 确认 `control/` 层零改动即可满足「成功才消费令牌」：成功回执 → `removeByCode`；失败（含超时）→ 令牌保留且回执含原因 —— 验证：分别构造成功、`ok:false`、超时三种情况，核对令牌消费状态与回执文案（对照 spec「应答令牌的消费语义」三个场景）
  - 结果：**`control/` 零改动确认**（`callBridge` 已统一 catch→返回错误描述，form 分支既有逻辑直接复用）。在 `scripts/control-protocol-smoke.ts` 新增「3b. 表单应答的令牌消费语义」组（10 断言），验证成功→消费、`ok:false`→保留+原因、超时→保留+提示、动作不匹配→静默不消费。实际回执样例：`应答失败 oc-…（令牌未消费）：当前没有终端客户端在运行（等待应答确认超过 5 秒），请回电脑处理`。

## 4. TUI 侧插件

- [x] 4.1 实现 `tui.ts` 的请求处理器：收到 `events.request` 后按 design D2 判定归属 —— 位置匹配（主）→ 会话持有（次，必要时先 `sync`）→ 不匹配则**直接静默返回**，不投递、不回调 —— 验证：单终端在线时归属通过；伪造一条不属于本终端的请求时静默返回（无 `form.reply` 调用、无 `confirm` 调用）
  - 结果：`tui.ts` 实现 `isOwnedByThisClient`（位置优先，回退会话持有）；实测 3 个 TUI 同时在线时，2 个打印「非归属客户端，跳过」、仅 `/home/lyf` 那个投递，**归属过滤精确生效**。
- [x] 4.2 归属通过后调用 `context.data.session.form.reply({ sessionID, formID, answer }, context.location)`，成功则 `confirm({ formID, ok: true })` —— 验证：真实提问场景下 agent 收到答案并继续
  - 结果：端到端实测通过 —— 手机发 `select <令牌> 2` → 宿主 form 被结算（`/api/session/<id>/form` 列表清空）→ 服务端回执「已回答 oc-…：选项B」→ **令牌被消费**。
- [x] 4.3 投递失败（含 `FormAlreadySettledError` 与其它异常）一律转成 `confirm({ formID, ok:false, failureKind })`，且**不向宿主重复投递** —— 验证：对同一 `formID` 并发触发两次投递，第二次得到已结算错误并回报 `ok:false`，服务端只收到一次成功
  - 结果：`isAlreadySettled` 识别协议层 `FormAlreadySettledError`（`_tag`）+ 文案兜底；重复/重放由 `inFlight` 集合挡掉、已结算静默（不重复投递、不回执）。另新增 `describeError`（Effect 错误 `String()` 会退化成 `[object Object]`，原实现把 `confirm` 失败误报成「投递失败」）。

## 5. 通知文案

- [x] 5.1 更新提问通知的应答邀请，移除「无法从手机应答」类声明（`index.ts` 相关文案与 `doc/features.md` 的对应说明）—— 验证：发出的提问通知正文不含该类字样，且含可用的应答提示（对照 spec「提问通知不再宣示能力缺失」）
  - 结果：`index.ts` 的启动告警改为「提问应答经 TUI 入口投递；若终端客户端未运行，应答会超时并如实回执」；`replyHint` 本就正常。实测通知正文为 `📱 回复: select <令牌> 1~2=选选项 …`（无能力缺失声明）。文档侧同步更正 `doc/features.md`（段落 + 命令表 2 行标注）、`README.md`、`doc/notify-format-test.md`。
- [x] 5.2 更新 `AGENTS.md` 中关于「提问默认无法从手机应答」的约定与 `doc/v2-plugin-form-mechanism.md` 的结论，使其与新实现一致 —— 验证：两处文档不再声称能力缺失，并指向实际实现位置
  - 结果：`AGENTS.md` 该条重写为「✅ 已打通」，含两入口、RPC 契约、**按 location 作用域**这一最大坑、结果判定、多终端归属、事件重放、边界、Effect 错误渲染；架构图加 `tui.ts` 与应答链路；冒烟清单加 `form-reply-bridge-smoke.ts`。`doc/v2-plugin-form-mechanism.md` 新增第 8 节「本仓库的实现与实测结论」（8.1~8.6）与第 9 节相关文件。

## 6. 验证与交付

- [x] 6.1 `npx tsc --noEmit` 通过，且三个本地冒烟脚本（`events-route-smoke` / `control-protocol-smoke` / `control-stream-smoke`）全绿 —— 验证：命令输出
  - 结果：`TSC` 通过；四个冒烟全绿（含新增 `form-reply-bridge-smoke`，27 断言）。
- [x] 6.2 端到端真实验收：在用户自己的 TUI 会话中触发 `question`，从手机分别做一次选项应答与一次自由文本应答，确认宿主收到答案且回执为成功 —— 验证：`plugin.log` 与 ntfy 回执双向核对
  - 结果：用 API 建真实 form + 真实 ntfy 命令通道完成两轮验收（**选项应答** `select <令牌> 2` → 回执「已回答 oc-…：选项B」，宿主 form 列表清空；**自由文本应答** `answer <令牌> 文本` → 回执「已回答 oc-…」）。均走完「服务端 → RPC → TUI → form.reply → confirm」全链路。
- [x] 6.3 无终端场景验收：关闭所有终端客户端后从手机应答，确认在超时窗口内收到「无法从手机应答」类回执，且令牌未被消费、重开终端后可重试成功 —— 验证：回执文案 + 重试成功
  - 结果：用「form 位于无终端客户端的 location（`/tmp/opencode`）」等效构造（不打扰用户正在使用的终端）。实测：3 个终端全部判为非归属并静默 → 5s 后超时 → 回执「应答失败 oc-…（令牌未消费）：当前没有终端客户端在运行（等待应答确认超过 5 秒），请回电脑处理」，宿主 form 仍在待处理（令牌未消费）。
- [x] 6.4 多终端竞争验收：同时开两个终端客户端，从手机应答一条提问，确认仅归属方投递、另一方静默、且通知侧无重复回执 —— 验证：两端 `plugin.log` 与 ntfy 回执
  - 结果：实测 **3 个终端客户端**同时在线（location 分别为 `/home/lyf`、`…/mycbdHub`、`…/opencode-notify`），从手机应答 `/home/lyf` 的提问：仅 `/home/lyf` 那个投递并成功，另两个打印「非归属客户端，跳过」，**且只产生一条回执**。
- [x] 6.5 代码走查：按项目规范走查本次改动（边界、死代码、数据隔离、调用链、无用代码），输出分级问题清单 —— 验证：走查报告
  - 结果：走查发现并修复 **1 项高**（`tui.ts` 把 `form.reply` 与 `rpc.confirm` 放在同一 try：投递成功但回调失败会被误报成「应答失败、令牌未消费」，而表单其实已应答 —— 已拆成两步 try，回调失败只记日志）与 **1 项低**（未使用的 `FormReplyRpcClient` 类型）。详见下方走查报告。
