# Task Plan: ntfy 单话题双向回复（合并 topic + 数字选选项 + 显式回复协议）

## Goal
ntfy 渠道支持单话题双向收发（通知+命令共用一个 topic，靠 bot_tag 防回环）；
手机可一键跳转话题页打字回复；回复协议全部显式（数字选选项 / answer / say 等），
无动词文本不猜、回执语法提示；通知正文尾部附带可回复命令提示，用户无需记忆命令。

## Next Step
全部完成。可选项：select 命令真机复测（copy 模板已改为 select）。

## Current Phase
全部完成（凭证强制协议 + 真机验证）

## Phases

### Phase 6: 凭证强制协议（用户 3 条新要求）
- [x] 方案设计：唯一凭证=一次性令牌 oc-xxx；sc-xxxx 退役为纯展示；无凭证一律静默（无回执）；失败（重复/过期/异主/无凭证）全部静默；status 验证不消费；续接令牌 TTL 内可复用
- [x] types.ts：PendingItem.kind 加 "session"
- [x] parser.ts 重写：approve/deny/always/answer/say/stop/status <令牌> + **select <令牌> <数字>**（同义 option/选择/选项；**无动词简写已废除**——所有命令必须有明确动词）
- [x] controller.ts：凭证门卫（归属验证不消费）+ execute 按凭证 kind 分发（不符返回 null 静默）+ 删 mostRecent/语法提示回执
- [x] sessions.ts 退役路由职责（留展示码生成）
- [x] index.ts：提问提示行 select 语法；run_* 注册 session 凭证；status 按钮带凭证
- [x] senders/ntfy.ts copy 值更新（提问=answer 令牌；完成=say 续接令牌）
- [x] 测试重写（protocol smoke：11 条无凭证拒绝断言 + select/简写废除断言 + session 可复用/过期）+ 集成 gate 子命令
- [x] 文档同步（features/README/AGENTS/yaml.example）+ tsc + 全量验证
- [x] 真机 gate：7 种无凭证探针全部静默 0 回执
- [x] 真机 answer 凭证回复：`收到命令 action=answer token=oc-932e-f8430c`
- [x] 真机活跃超时后通知即时送达（sleep 70s 验证）
- [x] copy 模板修正：提问=select <令牌>（原 answer 割裂）
- **Status:** complete

## Phases

### Phase 1: 方案设计与用例推理验证
- [x] librarian 查证 ntfy Android 能力（5 轮：直接回复/深链/tags 白名单/copy 动作/按钮上限/非按钮通道）
- [x] 方案定稿（用户 3 点反馈 + copy 半自动带会话码 + 去掉 view 按钮）
- [x] 场景用例推理验证（10 场景）
- [x] 验证结论回填 findings.md，8 缺口回修
- **Status:** complete

### Phase 2: 核心协议实现（control/）
- [x] types.ts：Command 加 `choose`；RawCommandMessage 加 `tags?`；ControlButton 加 `value?`；ReplyConfig 加 merged/botTag/copyButton
- [x] ntfy-common.ts：DEFAULT_BOT_TAG / isBotMessage / 回执发布带 tags
- [x] parser.ts：纯数字→choose（含 secret 分支）；无动词→失败（controller 回执提示）
- [x] sessions.ts：touch / mostRecent
- [x] controller.ts：choose 执行；会话码不属主静默忽略；无动词回执提示；copy/status 按钮；provider 传 botTag；noteNotified
- [x] ntfy-stream.ts / ntfy.ts：tags 字段 + botTag 过滤（游标仍推进）
- **Status:** complete

### Phase 3: 通知侧实现（senders/ + config + index）
- [x] senders/ntfy.ts：tags=[botTag]；http/copy 动作渲染（copy 不 clear）；replyHint 尾巴
- [x] message.ts：replyHint 字段
- [x] config.ts：command_topic 可选/可等于 topic → 合并模式；bot_tag / copy_button；回环校验调整
- [x] index.ts：选项编号（≥3）；各事件 replyHint；run_* copy+status 按钮；noteNotified；sender 传 botTag
- **Status:** complete

### Phase 4: 验证
- [x] tsc --noEmit
- [x] control-stream-smoke：5 场景（含 bot_tag 过滤）全绿
- [x] control-protocol-smoke：parser/config/按钮/sessions + 分离模式回归（全绿）
- [x] scripts/ntfy-integration.ts：真实 ntfy tags 往返 + bot_tag 过滤 4/4；preview/copy/actions 子命令供真机
- [x] 真机：合并话题、权限按钮 approve、say 续接、复制 answer 模板、纯数字 choose、连续两条提问都送达（去重修复）
- **Status:** complete

### Phase 5: 文档交付
- [x] doc/features.md / README.md / opencode-notify.yaml.example / config.ts 模板 / AGENTS.md
- [x] 走查：修复 4 处（分离模式 ≥3 选项空按钮回归、copy clear 改 false、command_topic==topic 归并、多进程限制文档化）
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 合并方式：省略 command_topic 即合并进 topic | 用户选定；填写则保持双话题兼容 |
| 裸文本不自动判型：必须显式（数字/answer/say…） | 用户明确要求"必须指明确"，绝不猜 |
| 纯数字 = 唯一待处理提问的选项序号 | 用户明确：作用于"一个问题中的多个选项"，非多问题；多提问并存→拒绝并提示 |
| 无动词文本不静默：回执语法提示 | 用户明确要提示 |
| 通知正文尾追加可回复命令提示 | 用户要求：不用记命令 |
| 不设 secret，安全边界=受保护话题+token | 用户选定（自托管）；裸文本/数字协议零前缀体验 |
| bot_tag 默认 "opencode"，非 emoji tag 弹窗不显示 | librarian 源码证实 tag 语义，弹窗干净 |
| [回复] 按钮 = view 深链 ntfy://host:port/topic | 源码证实 BROWSABLE filter 接管；正文无法预填（上游限制，已告知用户） |
| 会话码不属主进程 → 静默忽略不发回执 | 多进程防噪音，与令牌隔离同策略 |
| 仅实现 ntfy | 用户明确"可以只实现ntfy的" |

## Errors Encountered
| Error | Resolution |
|-------|------------|

## Errors Encountered
| Error | Resolution |
|-------|------------|
| 回执自激刷屏（500+ 条，真机） | stream provider 补 botTag + isSelfMessage 标题兜底 + 回执限流；回归测试锁死 |
| 连续提问 60s 内第 2 条被去重吞掉（真机） | 权限/提问去重 key 含 requestID |
| 其余编辑失误（误删声明行等） | 读文件后立即修复 |
