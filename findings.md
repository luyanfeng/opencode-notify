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
