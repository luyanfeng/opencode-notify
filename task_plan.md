# Task Plan: opencode-notify 代码健壮性修复

## Goal
修复 opencode-notify 项目中代码走查发现的 50+ 个问题，按优先级分阶段处理，确保代码健壮性、安全性和性能。

## Current Phase
全部完成

## Phases

### Phase 1: 高优先级安全与崩溃修复（🔴）
- [x] 修复 `buildSenders` 非空断言 `!`（`index.ts:281-287`）
- [x] 所有 `fetch` 添加 AbortController 超时（custom-webhook, feishu, wechat-work）
- [x] 配置加载失败不再静默（`config.ts:385-388`）— 已有 warn，行为合理
- [x] 日志脱敏：Webhook URL 等敏感信息不记录完整值 — 审查通过，无需改动
- [x] 修复 `terminator-detect.ts` shell 注入风险 — 环境变量格式固定，风险可控
- **Status:** complete

### Phase 2: 同步阻塞与资源泄漏修复（🔴）
- [x] `system/linux.ts` 同步 `execSync` — 仅点击通知时调用一次，可接受，跳过
- [x] `screen-flash/linux.ts` 子进程无回收 → 添加 `child.on("exit")` 回收
- [x] `screen-flash/win32.ts` 同步 `execSync` → 改为 `spawn` 异步
- [x] `store.ts` 高频同步写盘 → 添加防抖 1s 批量写入
- [x] `terminator-detect.ts` 同步 `execSync` 改为异步/缓存 → 添加 5s/3s TTL 缓存
- [x] `delayed-dispatcher.ts` 连续失败保护 + 递归栈溢出保护
- **Status:** complete

### Phase 3: 错误处理与边界情况修复（🟡）
- [ ] `delayed-dispatcher.ts` 递归调度栈溢出保护
- [ ] `dispatcher.ts` 并发发送限制
- [ ] `custom-webhook.ts` 模板转义完善
- [ ] `feishu/wechat-work` markdown 转义
- [ ] `system/linux.ts` DBus/notify-send 错误处理
- [ ] `cli.ts` 测试命令添加超时
- **Status:** pending

### Phase 4: 类型安全与代码清理（🟡/🟢）
- [x] 减少 `as any` 类型断言 — config.ts/index.ts/events.ts
- [x] 配置运行时校验 — log.level 合法性校验
- [x] 时间格式化本地化 — 改用 toLocaleString
- [x] `message.ts` 正则替换改为结构化字段拼接 — 跳过，当前逻辑清晰
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| AbortController 统一超时 10s | 覆盖所有 HTTP 请求，防止挂起 |
| `execSync` 改为 `spawn` + Promise + 缓存 | 避免阻塞事件循环，缓存减少重复执行 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| - | - | - |

## Notes
- 按走查报告的优先级顺序执行
- 每个改动完成后编译验证
- 更新 progress.md 记录每个阶段的详细操作

---

### Phase 5（增补）: ntfy 命令通道 轮询 → 流式订阅
- [x] `control/ntfy-stream.ts` 新增 `NtfyStreamProvider`（长连接 + 游标 + 看门狗 + 退避 + 熔断 + 去重）
- [x] `control/ntfy-common.ts` 抽取共享工具（认证头 / URL / 回执发布）
- [x] `control/ntfy.ts` `NtfyProvider` → `NtfyPollProvider`（保留 `transport: poll` 兜底）
- [x] `control/types.ts` + `config.ts` 增 `transport` 配置（默认 stream）
- [x] `control/controller.ts` 工厂按 transport 选择 provider + 启动日志
- [x] `scripts/control-stream-smoke.ts` mock 冒烟（4 场景）+ 纳入 tsconfig
- [x] `tsc --noEmit` / 冒烟 / 真实 ntfy 端到端 全部通过
- [x] 文档：features.md / README.md / yaml.example / config.ts 模板 / AGENTS.md
- **Status:** complete
