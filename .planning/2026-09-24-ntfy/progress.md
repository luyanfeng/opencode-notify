# Progress Log

## Session: 2026-09-24

### Current Status
- **Phase:** 4 - 验证（Phase 2/3 已实现，tsc + 两套冒烟通过）

### Actions Taken
- Phase 1 完成：librarian 5 轮查证（ntfy Android 能力 / 深链 / header 白名单 / copy 动作 / 按钮上限 / 非按钮通道）
  + 10 场景推理验证 + 8 缺口修补；用户实测确认按钮上限=3（服务端 400）、copy 可复制、深链不能直达输入框。
- Phase 2 完成（core/）：types（choose/tags/merged/botTag/copyButton/ControlButton.value）
  / ntfy-common（DEFAULT_BOT_TAG/isBotMessage/回执带 tag）/ sessions（touch/mostRecent）
  / parser（纯数字→choose，含 secret 分支）/ controller（choose 执行、会话码非属主静默、无动词回执、copy/status 按钮、botTag 传参）
  / ntfy + ntfy-stream（tags 字段 + botTag 过滤，游标仍推进）。
- Phase 3 完成（通知侧）：senders/ntfy（tags 标记 + http/copy 动作渲染 + replyHint 尾巴）
  / message.ts（replyHint 字段）/ config.ts（command_topic 可选=合并模式、bot_tag、copy_button、回环校验调整）
  / index.ts（选项编号、各事件 replyHint、run_* 的 copy+status 按钮、noteNotified 最近会话、sender 传 botTag）。
- Phase 4 进行中：tsc --noEmit 通过；control-stream-smoke 5 场景全绿；
  control-protocol-smoke 39 项全绿；真实 ntfy tags 往返 e2e。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| tsc --noEmit | 无类型错误 | 通过 | ✅ |
| control-stream-smoke（5 场景） | 全通过 | 全通过 | ✅ |
| control-protocol-smoke（parser/config/按钮/sessions） | 全通过 | 39/39 | ✅ |
| 真实 ntfy tags 往返 + botTag 过滤 e2e | 全通过 | 待跑 | ⏳ |
| 用户真机（合并话题 + copy 按钮 + 数字回复） | 待联调 | - | ⏳ |

### Errors
| Error | Resolution |
|-------|------------|
| 编辑 parser.ts 时误删 HELP_TEXT 声明行 | 读文件后补回 `export const HELP_TEXT = [` |
| 编辑 smoke 脚本时误删 collect() | 读文件后补回 |
| config.ts 缺 merged/botTag/copyButton | resolveReplyConfig 补全（合并模式推导） |
| controller execute 新增 choose 后 switch 非穷尽 | 补 choose 分支 |
| **【严重·真机暴露】回执自激刷屏（500+ 条）** | 见下 |

## 严重 Bug 复盘：回执自激刷屏（2026-09-25 真机联调暴露）

### 触发链
1. `control/ntfy-stream.ts:publishReceipt` **漏传 `botTag`**——我只改了 poll provider（`ntfy.ts`），漏了**默认的 stream provider**，回执发布无 `tags:[botTag]`。
2. 合并单话题下，插件订阅端读回自己的回执（无 tag → `isBotMessage` 不识别）。
3. 「无动词文本 → 回执语法提示」把回执当未识别命令 → 再发回执 → 无限自激。

### 根因教训
- `publishReceipt` 有 **两个实现**（stream/poll），我只修/测了 poll，而**运行时默认走 stream** → "默认路径未覆盖"。
- 新增"回执语法提示"改变了行为面：任何回环从"静默"升级为"自激"——**新增自动回复类行为必须同步加防回环兜底**。

### 修复（三层防御）
| 层 | 修复 |
|---|---|
| 根因 | `ntfy-stream.ts:publishReceipt` 补 `botTag` |
| 结构兜底 | 新增 `isSelfMessage()`：回执固定标题 `RECEIPT_TITLE`，即使 tag 缺失/配错也绝不解析（stream/poll provider + controller 三处调用） |
| 熔断限流 | `controller.reply()` 限流：10s 窗口 ≤8 条，超出丢弃+告警，任何未知回环不再刷屏 |

### 回归测试（锁死复发）
- `control-stream-smoke` 场景 6：缺 bot_tag 的回执（含回执标题）必须被过滤。
- `control-protocol-smoke` `isSelfMessage`：tag 标记 + 回执标题兜底 6 项断言。

## Phase 6：凭证强制协议（2026-09-25，用户 3 条新要求）

### 用户要求 → 实现
1. 每个通知携带会话凭证 → 权限/提问=一次性令牌；**完成类新增 session 型续接凭证**（TTL 内可反复 say/stop）
2. 无凭证一律忽略、不发回执 → parser 无令牌即失败；controller 门卫静默；**语法提示回执删除**（根除自激最后一环）
3. 凭证一次性/过期不受理 → permission/question/choose 用后即废；session 型 TTL 内可复用；重复/过期/异主全部"查无此证"静默

### 协议最终形态（全部显式动词 + 令牌，无动词简写废除）
approve/deny/always <令牌> · answer <令牌> <文本> · **select <令牌> <数字>**（同义 option/选择/选项）
· say <令牌> <文本> · stop <令牌> · status <令牌>（验证不消费）· help

### 决策（用户拍板）
- sc-xxxx 退役为纯展示；失败一律静默（无提示回执）；status 验证不消费；续接令牌 TTL 内可复用；select 动词化（无动词简写废除）；提问 copy 模板=select <令牌>

### 真机验证（gate + 端到端）
- gate：7 种无凭证探针（裸数字/越界/裸say/旧会话码/无令牌approve/无动词/伪造令牌）→ **0 回执** ✅
- 凭证回复：`收到命令 action=answer token=oc-932e-f8430c` → 回执 ✅
- 活跃超时（70s）后通知即时送达手机 ✅（此前"时灵时不灵"=抑制+Terminator 遮挡覆盖的机制所致，非 bug）

### 观测性补充
- `control: 收到命令/已处理命令并回执/忽略无凭证…` info 日志链路（修复"手机命令有无响应无法从日志判断"）
