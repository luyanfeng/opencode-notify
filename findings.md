# Findings & Decisions

## 代码走查结果摘要
2026-06-24 对全项目进行了代码走查，覆盖 20 个 .ts 文件，发现约 50 个问题。

### 问题分布
| 严重程度 | 数量 | 主要类型 |
|----------|------|----------|
| 🔴 高 | 8+ | 运行时崩溃、进程挂起、僵尸进程、日志泄露 |
| 🟡 中 | 10+ | 类型安全、并发控制、边界情况 |
| 🟢 低 | 10+ | 代码风格、本地化、性能优化 |

### 关键发现
1. **`buildSenders` 非空断言**：`ch?.screen_flash!` 等 4 处，配置缺失时直接崩溃
2. **`fetch` 无超时**：3 个文件（custom-webhook, feishu, wechat-work），远程挂起会卡死插件
3. **多处 `execSync` 同步阻塞**：terminator-detect.ts 和 linux.ts 中共 10+ 处，每次 3s
4. **子进程无回收**：screen-flash/linux.ts 创建分离进程不监听 exit
5. **日志泄露敏感信息**：index.ts 记录完整配置，含 webhook URL
6. **配置静默失败**：YAML 格式错误返回 null，调用方 ?? {} 完全掩盖

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 统一用 AbortController + 10s 超时 | 覆盖所有 HTTP 请求场景 |
| `execSync` → `spawn` + Promise 封装 | 非阻塞 + 可超时 + 安全参数传递 |
| 缓存策略：窗口激活结果缓存 30s TTL | 减少重复 `execSync` 调用 |
| 去重存储：防抖 1s 批量写入 | 减少高频 IO |
| 日志脱敏：URL 显示 scheme + host，隐藏 path/query | 平衡调试和安全 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| - | - |

## 远程应答「(服务返回错误)」根因（2026-09-24）
- **现象**：手机点 ntfy 按钮「允许」后，回执显示「已允许 xxx (服务返回错误)」。
- **根因**：`control/controller.ts` 原以 `createOpencodeClient({ baseUrl: String(_input.serverUrl) })` 自建 v2 client。`opencode` 直跑（非 server）时服务在同进程内、不监听 HTTP 端口，`_input.serverUrl` 恒为兜底值 `http://localhost:4096`（死地址）→ fetch 失败 → SDK 返回 `{error:{}}`（truthy）→ 回执追加「(服务返回错误)」（`controller.ts` 的 `res.error` 判断）。
- **源码依据（opencode 1.18.32）**：
  - `packages/opencode/src/plugin/index.ts`：注入 client 的 `fetch` 在无 serverUrl 时为 `Server.Default().app.fetch`（内存 fetch），`baseUrl` 兜底 `http://localhost:4096`；`get serverUrl()` 永远返回 URL（永不 undefined）。
  - `packages/opencode/src/cli/cmd/tui.ts`：直跑（非 `--port/--hostname`）走 `createWorkerFetch`，server 跑在 Worker 内，不 listen TCP（实测 `ss -tlnp` 无 opencode LISTEN）。
  - `packages/sdk/js/src/gen/sdk.gen.ts`：注入 client 是 **v1**，仅有 `postSessionIdPermissionsPermissionId`，**无** `permission`/`question` 命名空间。
  - `packages/sdk/js/src/gen/client/client.gen.ts`：`createClient` 返回对象含 `getConfig()`，保留构造时的 `fetch`；`_HeyApiClient._client` 即该对象。
- **修复**：`controller.ts` 新增 `buildV2Client()`，从注入 client 的 `_client.getConfig()` 提取 `fetch`/`headers` 构造 v2 client（`Headers` 实例需归一化为普通对象，否则 v2 内部 `{...headers}` 展开丢认证头）。`index.ts` 原样传入 `_input.client`（`unknown`）。
- **验证**：`tsc` 通过；模拟直跑注入（内存 fetch）实测 `permission.reply` 返回 `{data}` 且命中内存 fetch、认证头保留。
