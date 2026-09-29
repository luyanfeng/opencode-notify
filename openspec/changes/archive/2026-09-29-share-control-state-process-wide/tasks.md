## 1. 进程级状态模块

- [x] 1.1 新建 `control/runtime-state.ts`：定义会合点键 `__opencodeNotifyControlState__`、状态形状 `{ instance, registry, fingerprint }`，导出 `getControlState(config)`（含指纹比对、重建+迁移+显式裁剪）与测试所需的 `__resetControlStateForTest()` —— 验证：`npx tsc --noEmit` 通过，且模块顶部写明「写侧约束：仅 owner 调用 registerPending」
  - 结果：新建 `control/runtime-state.ts`；文件头写明「写侧约束：仅 owner 写注册表」与隔离边界（`globalThis` = 进程边界）。`TSC=0`。
- [x] 1.2 在 `control/pending.ts` 增加最小迁移能力：`snapshot()` 返回条目深拷贝、`restore(items)` 写回并**显式裁剪到 max** —— 验证：新增断言覆盖「迁移保留条目」「restore 后条数 ≤ max」
  - 结果：`snapshot()` 深拷贝（选项数组也复制）；`restore()` 写回后显式裁剪到 `max`（保留最新者）。断言见 task 3.1 的冒烟。

## 2. controller 接入

- [x] 2.1 把 `control/controller.ts` 的 `private readonly instance = newInstanceId()` 改为从 `getControlState(...)` 取（constructor 里完成）—— 验证：`TSC` 通过，且日志「实例=」与实际门卫一致
  - 结果：`instance` 改为 constructor 内从 `getControlState()` 取并存为 `private readonly instance: string`。
- [x] 2.2 把 `this.registry = new PendingRegistry(...)` 改为从 `getControlState(...)` 取 —— 验证：同一进程内两个 controller 实例得到**同一个** registry 对象
  - 结果：`registry` 同样取自 `getControlState()`。冒烟 3.1 断言「同进程两个 controller 得到同一 registry 对象」。
- [x] 2.3 确认 `newInstanceId()` 的调用点只剩 `runtime-state.ts` 一处（`tokens.ts` 函数本身不动）—— 验证：`grep` 结果唯一
  - 结果：`grep` 确认仅 `runtime-state.ts:79` 调用；`tokens.ts` 只保留定义。

## 3. 冒烟（把自证推演固化为回归）

- [x] 3.1 新增 `scripts/control-credential-sharing-smoke.ts`，用**真实** `PendingRegistry` + `getControlState` 覆盖：① 同进程 owner 变更后令牌仍受理；② 等待期间变更不丢条目；③ 不同进程（不同 `globalThis` 沙箱）互不受理；④ 跨机器等价场景；⑤ 配置指纹变化时重建+迁移且新参数生效；⑥ 容量上限变小时立即裁剪；⑦ 指纹未变时复用同一 registry —— 验证：脚本全绿
  - 结果：新增冒烟，10 组共 **31 断言全过**（另含静默语义、同进程多实例共享、snapshot 深拷贝）。
- [x] 3.2 若测试需要隔离 `globalThis`，采用**显式重置**（`__resetControlStateForTest`）而非 mock —— 验证：脚本可重复运行且结果稳定
  - 结果：用 `__resetControlStateForTest()` 隔离用例；连续两次运行均 31/31 全绿。

## 4. 回归与端到端复现验证

- [x] 4.1 `npx tsc --noEmit` 通过；四个既有冒烟（`events-route-smoke` / `control-protocol-smoke` / `control-stream-smoke` / `form-reply-bridge-smoke`）全绿 —— 验证：命令输出
  - 结果：`TSC` 通过；五个冒烟全绿（含新增 `control-credential-sharing-smoke` 31 断言）。
- [x] 4.2 **端到端复现原 bug 场景**：发出授权/提问通知 → 期间新建另一个 location 的会话触发实例夺权 → 从手机应答该令牌，确认回执为**成功**（修复前为静默丢弃）—— 验证：`plugin.log` 中不再出现「忽略无归属令牌」，且回执为成功
  - 结果：**通过**。令牌 `oc-8e11-551227` 发出 → 热重载触发 owner 变更（5 次让位/上位，4 个 location 轮流夺权，实例前缀**始终为 `8e11`**）→ 手机应答 → 日志「收到命令」通过前缀门卫（修复前此处即被「忽略无归属令牌」丢弃）、`[tui] 投递成功`、回执「**已回答 oc-8e11-551227：乙**」、宿主 form `pending=0`。全程无「忽略无归属令牌」。
- [x] 4.3 **跨进程隔离回归**：另起一个 server 进程（如 `serve --port` 或 `--standalone`），确认两进程令牌互不受理、无回执串答 —— 验证：两进程日志
  - 结果：**通过**。用 `opencode run --standalone`（自带私有 server，另一个 location）起**真实的独立进程**：其日志显示 `控制状态: 已建立 实例=8505`，而主进程四个 location 共用 `实例=8e11` —— **两进程前缀不同，互不受理**（跨机器等价于跨进程，冒烟第 4 组已直接验证）。
- [x] 4.4 **热重载回归**：热重载插件后，重载前发出的令牌仍可用 —— 验证：日志 + 手机回执
  - 结果：与 4.2 同一轮验证覆盖 —— 令牌于热重载**前**发出，重载（含 5 次 owner 变更）后应答**成功**。

## 5. 文档同步

- [x] 5.1 更新 `AGENTS.md`：令牌隔离的粒度由「每 location 实例」更正为「每 server 进程」，写明会合点、写侧约束（仅 owner）、配置指纹机制；并补一条「同机多 server 进程仍隔离」的说明 —— 验证：与代码一致
  - 结果：`AGENTS.md` 新增两条（隔离粒度 + 指纹重建），删去过时条目，令牌格式耦合处由 4 处更新为 **5 处**（加 `runtime-state.ts`），「replyForm 必然失败」表述改为「超时/无终端、宿主已结算等」，冒烟清单加 `control-credential-sharing-smoke.ts`。
- [x] 5.2 更新 `doc/features.md` / `README.md` 的相关描述（若有「令牌随实例前缀」的表述需同步）；并在 `doc/v2-plugin-form-mechanism.md` 或新文档中记录本次根因与修法 —— 验证：无过时表述残留
  - 结果：`doc/features.md`（防重复第 3 条 + 多实例/多机安全段）、`README.md`（防重复段）均改为「server 进程」粒度并标注「新项目/热重载不再失效」；`doc/v2-plugin-form-mechanism.md` 新增 **8.7 同源病根**（含"进程级放 globalThis、location 级放实例"的规律）与 **8.8 升级边界**。
- [x] 5.3 发布说明需提及升级边界：**升级瞬间**旧实例的私有注册表不会并入共享状态，待处理令牌可能一次性失效 —— 验证：文档中有该条
  - 结果：仓库无 CHANGELOG，升级边界记入 `doc/v2-plugin-form-mechanism.md` 第 8.8 节（触发条件 / 影响面 / 规避方式），AGENTS.md 已指向该文档。
