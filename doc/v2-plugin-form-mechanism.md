# opencode 2.x 插件机制：form（提问）应答到底在哪一层

> **本文目的**：opencode 2.x 的「提问（form）能否从手机应答」这个问题反复查过多次，
> 每次都要重新翻 SDK 源码。此文档把结论、依据、以及**实现与实证**固化下来，避免重复考古。
>
> **结论一句话**：`form.reply` **真实存在**，但**只存在于 TUI/CLI 插件上下文**，
> **不在服务端插件上下文**里。所以不是"opencode 没有这个能力"，而是"走错了入口"。
>
> **✅ 本仓库已按此实现**（change `add-tui-form-reply`）：
> 同包导出 `./tui`（`tui.ts`）+ RPC 回调确认，手机应答提问已端到端打通。见第 8 节。

---

## 0. 前提：V1 与 V2 的进程架构（理解这条边界的关键）

**V1：TUI 进程内自带 server，插件就在 TUI 进程里。**
V1 插件签名 `async ({ project, client, $, directory, worktree }) => ({ hooks })` ——
既要 `client`（说明连着 server），又要 `$`（Bun shell，说明在同一运行时里跑代码），
且插件**直接消费 TUI 事件**（`tui.prompt.append` / `tui.command.execute` / `tui.toast.show`）。
若插件在另一个进程，就消费不到 TUI 事件 —— 所以 **V1 的插件宿主就是 TUI 进程本身**，
server 组件与 TUI 组件同进程。V1 下**不存在**"插件够不到客户端能力"的问题。

**V2：拆成「常驻共享后台服务 + 多个客户端」。**
官方原文：

> OpenCode uses a **client-server architecture**. Interfaces such as the **TUI connect to a
> background OpenCode service**, which owns sessions, configuration, plugins, permissions,
> and tool execution.

> `server`: use the V2 service and explicit server options; **the server API is an intentional
> breaking change**.

> The terminal client owns `cli.json`; **the background service does not load it**.

本机实测（V2.0.18）：

| 进程 | 角色 | 证据 |
|------|------|------|
| `opencode.exe serve --service` | server（常驻） | 监听 `127.0.0.1:49374`；`role=server` 加载插件 |
| `opencode -c`（可多个） | TUI 客户端 | **不监听任何端口**；`role=cli` 插件对账（`plugins=13`） |

### 这条拆分造成的两个直接后果

1. **"一次事件发 N 条重复通知"**：`ctx.event.subscribe` 订阅的是**服务端公共事件流**，
   而该服务端被多个客户端（多个 TUI、多个项目 location）共用；插件按 location 各加载一份 →
   同一事件被 N 份实例各处理一遍。V1 无此问题（一 TUI 一 server）。本仓库用
   `process-singleton.ts`（进程内单例）+ `store.ts`（跨进程 O_EXCL 按键占位）收敛。
2. **`form.reply` 被进程边界劈开**：表单应答要在**客户端**侧执行，而通知插件挂在**服务端**
   （为了跨客户端全局只发一条）。V1 时代插件就在 TUI 进程里，提问应答根本不需要跨进程。

> **一句话**：V2 的分工是「服务端要全局唯一视角，客户端要本地交互能力」，二者不可兼得，
> 于是用**两套插件入口**（`.` 服务端 / `./tui` 客户端）覆盖两边。本插件只用了 `.` 半边。

---

## 1. 两套插件上下文（根因所在）

opencode 2.x 的 `@opencode/plugin` 包对外暴露**多个入口**，对应**不同的运行宿主**：

| 入口 | 常量 | 运行位置 | 用途 |
|------|------|---------|------|
| `.` | `@opencode/plugin` | **server 进程** | 服务端插件（本插件 `index.ts` 用的就是这个） |
| `./tui` | `@opencode/plugin/tui` | **TUI/CLI 进程** | 终端插件：命令、路由、槽位、渲染器、通知 |
| `./effect` | `@opencode/plugin/effect` | 同上（Effect 版） | Effect 风格写法 |
| `./host` | `@opencode/plugin/host` | — | 宿主适配层内部使用 |
| `./rpc` | `@opencode/plugin/rpc` | — | RPC 定义（见第 5 节） |

依据：`@opencode/plugin/package.json` 的 `exports` 字段。

```json
{
  "exports": {
    ".":       { "types": "./dist/promise/index.d.ts" },
    "./effect":{ "types": "./dist/effect/index.d.ts" },
    "./tui":   { "types": "./dist/tui/index.d.ts" },
    "./host":  { "types": "./dist/host.d.ts" }
  }
}
```

---

## 2. 服务端插件上下文（`.`）——**没有 form**

### 2.1 类型层：24 个域，无 form

`@opencode/plugin/dist/promise/plugin.d.ts`：

```ts
export interface Context {
  readonly app; readonly location; readonly options;
  readonly agent; readonly aisdk; readonly command; readonly event;
  readonly experimental; readonly integration; readonly mcp; readonly model;
  readonly generate; readonly permission; readonly plugin; readonly provider;
  readonly reference; readonly rpc; readonly session; readonly shell;
  readonly skill; readonly storage; readonly tool; readonly vcs;
  readonly websearch; readonly worktree;
}
```

`SessionDomain` 是一个 **`Pick`**，明确列出允许的成员（`promise/session.d.ts:143`）：

```ts
export type SessionDomain = Pick<SessionApi,
  "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate"
  | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" | "context"
> & { readonly hook: ModelHooks<SessionHooks> }
```

**`form` 不在这个 Pick 里。** 对比同包内的 `PermissionDomain`：

```ts
export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & { ... }
```

权限有 `reply`，表单没有 —— 不是能力缺失，是**没被接进来**。

### 2.2 运行时层：白名单对象字面量，真的没有

类型定义可能只是"没声明"。运行时实测（临时探针 dump `Object.keys(ctx.session)`）：

```
session keys = ["command","context","create","generate","get","hook","interrupt",
                "move","prompt","switchAgent","switchModel","synthetic","update","wait"]
hasForm = false

ctx keys = ["agent","aisdk","app","command","event","experimental","generate",
            "integration","location","mcp","model","options","permission","plugin",
            "provider","reference","rpc","session","shell","skill","storage","tool",
            "vcs","websearch","worktree"]        ← 也没有 form
```

代码层依据：`@opencode/plugin/dist/promise/adapter.js:417-432` —— 服务端 ctx 是**显式白名单字面量**：

```js
session: {
  hook: (...), create: adaptApiMethod(...), get: ...,
  switchAgent: ..., switchModel: ..., prompt: ..., generate: ...,
  command: ..., synthetic: ..., interrupt: ..., update: ..., move: ...,
  wait: ..., context: ...,
},              // ← 没有 form
```

### 2.3 没有"绕过"的逃生口

- **`ctx.app`**：只有 `{ name, version, channel }`（SDK `@opencode/plugin/dist/app.d.ts`），**没有 server URL / 认证信息**，无法自建 HTTP client 打 `/api/session/{id}/form/{formID}/reply`。
- **`ctx.rpc`**：只能调**插件自己用 `ctx.rpc.register()` 注册的 RPC**，不是通用 HTTP 通道。
- **`ctx.session`** 上没有任何 `form*` 相关方法。

### 2.4 服务端侧**确实存在** form 端点（API 层没问题）

```
GET    /api/session/{sessionID}/form              # 列表
POST   /api/session/{sessionID}/form              # 创建
GET    /api/session/{sessionID}/form/{formID}     # 查询
DELETE /api/session/{sessionID}/form/{formID}     # 取消
POST   /api/session/{sessionID}/form/{formID}/reply   # ★ 应答
GET    /api/form
```

（实测来自运行中服务的 `GET /openapi.json`。）

`@opencode/client` 也完整暴露（`client/dist/effect/generated/client.d.ts:75-79`）：

```ts
session.form.list / create / get / reply / cancel
```

**所以：能力在 server 与 client 层都是齐的，只是没接进服务端插件 ctx。**

---

## 3. TUI/CLI 插件上下文（`./tui`）——**有 form**

`@opencode/plugin/dist/tui/context.d.ts`：

```ts
readonly client: OpenCodeClient          // 完整 client（可远程）
readonly data: Data

// Data.session 里：
readonly form: {
  list(sessionID: string, location?: LocationRef): Array<FormInfo & { location?: LocationRef }> | undefined;
  sync(sessionID: string, location?: LocationRef): Promise<void>;
  invalidate(sessionID: string, location?: LocationRef): void;
  reply(input: SessionFormReplyInput, location?: LocationRef): Promise<void>;   // ★
  cancel(input: SessionFormCancelInput, location?: LocationRef): Promise<void>; // ★
};
```

**这就是手机应答提问需要的 API。**

### 入参精确形状

```ts
// @opencode/client
type SessionFormReplyInput = {
  readonly sessionID: string;
  readonly formID: Form.ID;
  readonly answer: Form.Answer;       // Record<string, string | number | boolean | string[]>
};
type SessionFormCancelInput = { readonly sessionID: string; readonly formID: Form.ID };

// @opencode/schema/form
type Answer = Record<string, string | number | boolean | readonly string[]>;
type Value  = string | number | boolean | readonly string[];
```

> `answer` 的 key 是 form 字段的 `key`（opencode 的 `question` 工具用 `q0`/`q1`/…），
> value 是**选项的 `value`**（不是 `label`）。`multiple:true` 时为 `string[]`。

---

## 4. 落地路径：同包加 `./tui` 入口

### 4.1 官方支持（Publish and load）

官方文档《CLI plugins → Publish and load》原话：

> Export `./tui` beside the main plugin for automatic loading.

即**同一个 npm 包可以同时导出服务端插件与 TUI 插件**：

```json
// package.json（示意：新增 ./tui 入口；"tui.ts" 是本包将来要新建的文件）
{
  "exports": {
    ".":     "./index.ts",      // 现有：服务端插件（通知、远程控制）
    "./tui": "./tui.ts"         // 新增：TUI 插件（form 应答）——文件待建
  }
}
```

`tui.ts` 里即可直接调用：

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-notify.tui",
  async setup(context) {
    // 监听 form 创建，或订阅本包服务端插件注册的 RPC
    await context.data.session.form.sync(sessionID, context.location)
    const forms = context.data.session.form.list(sessionID, context.location) ?? []
    await context.data.session.form.reply(
      { sessionID, formID, answer: { q0: "选项的 value" } },
      context.location,
    )
  },
})
```

### 4.2 关于 `cli.json`：**不需要**额外配置

官方《CLI plugins》原文：

> Plugins configured in `opencode.json(c)` that expose a TUI component are **loaded automatically by the CLI**.
> **You do not need to add the same package to `cli.json`.** The CLI gets the active plugin list from the
> connected OpenCode server, so this also works when the server is remote.

即：只要包里有 `./tui` 导出，**终端客户端会自动加载**，`cli.json` 无需重复登记。
（`cli.json` 的 `plugins` 只服务于**纯 CLI 插件**——没有服务端对应物、且要在连远程 server 时也生效的那种。）

### 4.3 TUI 侧能力清单（判断"能不能整体搬过去"的依据）

`@opencode/plugin/tui` 的 `Context`（`tui/context.d.ts:458-474`）：

| 能力 | TUI 侧 |
|------|--------|
| 事件流 `data.on(type, handler)` / `data.listen(handler)` | ✅ 全量 OpenCode 事件 |
| `client`（完整 `OpenCodeClient`） | ✅ |
| `data.session.form.reply / cancel` | ✅ |
| `attention.notify()`（系统原生通知，带 focus 判定/音效） | ✅ |
| `ui.toast` / `ui.dialog` / 槽位 / 路由 / keymap / storage | ✅ |
| **`tool` 域（`list` / `transform` / `reload`）** | ❌ **没有** |
| `permission` / `command` / `provider` / `model` / `skill` / `agent` 的 transform | ❌ 没有 |

> **必须分清**：TUI 侧能做**通知**与**应答**（form / permission 走 `client` / `data.session.form`），
> 但**做不了任何 transform 类改造**（替换工具、注册命令、改 provider/model）。

### 为什么需要 TUI 插件这一环

本插件跑在 **server 进程**，而 `form.reply` 只在 **TUI 进程**的上下文里。
两者是**不同进程 / 不同 ctx**，因此服务端插件**必然拿不到** `form.reply`。
需要由 TUI 侧插件来执行应答。

### 通信方向（重要）

官方 RPC 是 **TUI → server** 方向：

```ts
// 服务端插件注册
const reg = await ctx.rpc.register(Acme, { search: async (input) => ... })
// TUI 插件调用
const acme = context.client.rpc(Acme)
await acme.search({ query: "hello" })
```

反过来（server → TUI）**没有官方 RPC 通道**。所以可行设计是**反过来触发**：
由 **TUI 插件**去拉取「待应答的 form」（`form.list` + RPC 或事件），
或是 TUI 插件监听 `form.created` 事件自行处理。
**具体方案需立项评估，此文档只固化"能力在哪、怎么调"。**

---

## 5. 能否把整个插件搬回 TUI 侧？

**结论：技术可行，但不建议；正确的做法是"双入口"而不是"搬家"。**

### 5.1 搬过去会得到什么

- ✅ 事件流（`data.on` / `data.listen`）—— 同样能拿到 server 的公共事件
- ✅ 完整 `client`（能调 services 发 HTTP、能 `permission.reply`、能 `session.form.reply`）
- ✅ `attention.notify()`（系统原生通知，自带 focus 判定与音效）
- ✅ 提问/权限应答能力（这正是现在缺的那块）

### 5.2 搬过去会失去什么（三条硬伤）

1. **覆盖变窄：没有 TUI 进程就完全没有通知。**
   服务端插件常驻后台，即使你没开终端也在跑（`opencode run`、定时任务、其他客户端触发的会话都能通知）。
   搬到 TUI 后，**"终端没开 = 失联"**，这比现在的覆盖面小得多。

2. **多 TUI 窗口会重复发通知。**
   实测本机同时开着 **2 个 `opencode -c`**。每个 TUI 客户端都会加载一份 TUI 插件，
   若各自发通知，就是"一个事件多条推送"——**和 V2 `process-singleton` 要解决的那个问题同构**，
   只是从"每 location 一份服务端实例"变成"每个 TUI 客户端一份"。
   且 TUI 插件**没有 `process-singleton` / O_EXCL 可依赖的进程级会合点**
   （各自独立进程，连 `globalThis` 都不共享），协调更难。

3. **失去服务端 `transform` 能力。**
   TUI 侧**没有 `tool` / `command` / `provider` / `model` / `agent` 等 transform 域**。
   本插件当前**没用到**这些（所以不是即时损失），但：
   - 将来若想用"包装 `question` 工具"等方案，**只能在服务端做**；
   - 注册自定义命令、改 provider/model 的能力也在服务端。

### 5.3 官方立场：**两者是两类，不是两选一**

官方把插件分成**两类对等的东西**（措辞见各页）：

| 官方表述 | 出处 | 含义 |
|---------|------|------|
| "Add published packages … to `opencode.json(c)`" | 《Plugins》 | **包插件的规范落点是服务端配置** |
| "`plugin check` checks **server and TUI-only package plugins** for updates" | 《Plugins → Manage》 | 官方把插件分为 **server 类** 与 **TUI-only 类** |
| "**CLI-only** plugins are configured separately and remain active when connected to a remote server" | 《Plugins → Terminal》 | `cli.json` 服务于 TUI-only 插件，且强调其特性是"连远程 server 时仍生效" |
| "Plugins configured in `opencode.json(c)` that expose a TUI component are **loaded automatically by the CLI**" | 《CLI plugins》 | **一个包可以是"服务端插件 + 它自带的 TUI 组件"**，CLI 自动加载，无需登记 `cli.json` |

**关键推论：**

1. **服务端是起点，不是"另一个选项"。** 插件在 `opencode.json` 配置；
   **只有暴露了 TUI 组件的包**才会被 CLI 顺带加载。
2. **`cli.json` 是给"纯 CLI 插件"用的**——那种**没有服务端对应物**、
   且**连远程 server 时也要生效**的插件（比如纯 UI 增强）。本插件显然不属于此类。
3. 因此对**本插件**：留在 `opencode.json`（现在就是这样），
   需要客户端能力时**在本包内补一个 `./tui` 导出**即可，`cli.json` 不用动。

> **验证等级说明**：本节 5.3 的依据是**官方文档原文**（已逐句引用出处）；
> "只需在 `opencode.json` 登记一次"这一条**本机未做对照实验**（需要改包并观察 CLI 行为），
> 属于官方承诺。实现 `./tui` 时**必须先实测确认**，不要直接依赖。

### 5.4 实践印证

- 本机 `opencode-planning-with-files`：只有服务端入口（`exports` 仅 `.`），
  只配在 `opencode.json`，`cli.json` 里没有 —— **正常工作**。
- 本机 `oh-my-opencode-slim`：同时导出 `.` / `./server` / `./tui` 三个入口 —— 官方"多入口"形态的现成样板。
- 官方《Migrate plugins from V1》整篇把 V1 插件迁到 **V2 服务端 API**
  （`ctx.event.subscribe` / `ctx.tool.transform` / `ctx.session.hook` …），
  即 V1 的 TUI 期插件在 V2 的对应落点是**服务端**；TUI 侧另有一套 CLI 插件文档。

### 5.5 为什么 V1 没有这个问题

V1 里 **TUI 与 server 同进程**：插件天然同时拥有「server 级事件流」+「TUI 本地交互」，
两者不冲突。**V2 把这两者拆到不同进程，能力被劈开了** —— 于是只能选边，
或两边都挂（官方给的答案就是两边都挂：`.` + `./tui`）。

### 5.6 建议

- **主体保留在服务端**（`.`)：常驻、全局唯一、跨客户端去重、保留 transform 能力。
- **只为"需要客户端交互的能力"补 `./tui`**：即 `form.reply`（以及必要时 `permission.reply` 的兜底）。
- 两边通过**待办交接**协作（服务端收命令 → 落盘待办 → TUI 侧执行 `form.reply`），
  因为官方 RPC 只有 **TUI → server** 单向，server → TUI 无通道。

---

## 6. 复核方法（下次怀疑结论时跑这些）

```bash
D=~/.config/opencode/node_modules/@opencode        # 运行时实际加载的那份

# 1. 确认服务端 ctx 没有 form（类型层）
grep -n "SessionDomain = Pick" $D/plugin/dist/promise/session.d.ts
grep -n "readonly form" $D/plugin/dist/promise/plugin.d.ts        # 应无输出

# 2. 确认 TUI ctx 有 form（类型层）
sed -n '60,75p' $D/plugin/dist/tui/context.d.ts

# 3. 确认服务端 ctx 是白名单字面量（运行时构造）
sed -n '415,435p' $D/plugin/dist/promise/adapter.js

# 4. 确认服务端端点存在
opencode api get /openapi.json | python3 -c "import json,sys;print([p for p in json.load(sys.stdin)['paths'] if 'form' in p])"

# 5. 版本核对（本结论基于 2.0.18；换版本必须重跑上面全部）
opencode --version && npm view @opencode/plugin version
```

**运行时探针法**（比类型定义更硬的证据，临时加、事后必须删）：

```ts
const s = ctx.session as unknown as Record<string, unknown>
info(`keys=${JSON.stringify(Object.keys(s).sort())} hasForm=${"form" in s}`)
```

---

## 7. 结论汇总

| 说法 | 判定 |
|------|------|
| "opencode 没有 form 应答能力" | ❌ **错**。server API 与 client 都有 `form.reply` |
| "插件机制天然支持 form 应答" | ✅ **对**，但**只在 TUI/CLI 插件上下文**（`@opencode/plugin/tui` → `context.data.session.form.reply`） |
| "服务端插件 ctx 有 form 域" | ❌ **错**。`Context` 无 form 域，`SessionDomain` 的 Pick 未含 form，运行时白名单字面量亦无 |
| "可以从服务端插件自建 HTTP 打 form 端点" | ❌ **不可行**。`ctx.app` 无 URL/认证，`ctx.rpc` 只到自己注册的 RPC |
| "同包导出 `./tui` 即可补齐" | ✅ **官方支持**的路径，是后续实现的落点 |
| "加了 `./tui` 后要在 `cli.json` 再登记一次" | ❌ **错**。暴露 TUI 组件的包**由 CLI 自动加载**，`cli.json` 无需重复配置 |
| "可以把整个插件搬回 TUI 侧" | ⚠️ **可行但不建议**。会失去后台常驻、多 TUI 窗口重复通知难协调、且 TUI 无 transform 能力 |
| "服务端与 TUI 二选一，官方提倡 TUI" | ❌ **错**。官方把插件分为 **server 类** 与 **TUI-only 类**：**包插件的落点是 `opencode.json`（服务端）**；暴露 TUI 组件的包由 CLI **自动**加载；`cli.json` 只给**纯 CLI 插件**（无服务端对应物、连远程也生效）用 |

---

## 8. 本仓库的实现与实测结论（change `add-tui-form-reply`）

按第 4/5 节落地后，实测发现**三条与直觉相反、必须记住**的行为：

### 8.1 ✅ `./tui` 确实由 CLI 自动加载（官方承诺成立）

实测：`package.json` 加 `exports["./tui"]` 后，新开终端客户端 → CLI 侧插件对账 `plugins=13 → 14`，
`setup` 被调用、cleanup 也在退出时调用。**`cli.json` 未做任何改动。**

### 8.2 ⚠️ RPC 注册是**按 location 作用域**的（最大的坑）

- 若只让**一个**实例注册 RPC（例如塞进单例 `activate`），则只有"恰好夺权那个 location"能用；
  **位于其它目录的 TUI 调 `client.rpc(D)` 会得到 `rpc.unavailable`**（实测报错原文：
  `RPC is unavailable: opencode-notify.form-reply`）。
- 正确做法：**每个实例都注册自己那份**（放在单例 `activate` 之外）。
- 连带结论：TUI 的 `confirm` 会打到**它自己 location 的那个实例**，可能是任意一个，
  所以**等待表不能是实例私有的**，必须放进程级共享的 `globalThis`
  （`form-reply-bridge.ts` 的 `__opencodeNotifyFormReplyWaiters__`）。这与 `process-singleton.ts`
  用 `globalThis` 而非模块级变量是同一个原因。

### 8.3 ⚠️ RPC 事件会**重放**

同一 `events.request` 载荷会在不同时刻被订阅方**反复收到**（探针实测同一 nonce 被多次收到）。
因此消费方必须**幂等**：`inFlight` 集合挡并发，`FormAlreadySettledError`（`_tag`）静默挡顺序重放。

### 8.4 ⚠️ Effect 错误 `String(e)` 会退化成 `[object Object]`

`context.data.session.form.reply` 抛出的错误是 Effect 的 `Schema.Class`，
直接 `String(e)` 得到 `[object Object]`，会把「投递成功、仅回调失败」误判成「投递失败」。
取信息要读 `_tag` / `message` 并 `JSON.stringify`（见 `tui.ts` 的 `describeError`）。

### 8.5 端到端实测结果

多终端同时在线（3 个不同 location），手机发 `select <令牌> 2`：

```
control: 收到命令 action=choose token=oc-…
  ├─ [tui] 非归属客户端，跳过  本位置=…/opencode-notify  请求位置=/home/lyf
  ├─ [tui] 非归属客户端，跳过  本位置=…/mycbdHub         请求位置=/home/lyf
  ├─ [tui] 投递成功  ← /home/lyf 的终端
  └─ control: 已回答 oc-…：选项B        （令牌被消费；宿主 form 列表清空）
```

**归属过滤精确生效，端到端打通。**

### 8.6 边界（设计使然，非缺陷）

- 应答由**终端侧**执行：没有终端客户端运行时无法应答，超时（默认 5s）后如实回执。
- 纯后台 `opencode run` 无终端，其无头提问被**宿主自行 dismiss**，插件管不到。

---

## 9. 相关文件

- 服务端插件入口：`index.ts`（`exports "."`；`bridge.replyForm` 已接 `FormReplyBridge`）
- TUI 插件入口：`tui.ts`（`exports "./tui"`；归属过滤 + `form.reply` + `confirm`）
- RPC 契约（两端共用）：`form-reply-rpc.ts`
- 服务端派发/等确认：`form-reply-bridge.ts`（含 `globalThis` 共享等待表）
- 命令/回执层：`control/controller.ts`、`control/pending.ts`、`control/types.ts`
- 通知渠道渲染按钮：`senders/ntfy.ts`
- 冒烟：`scripts/form-reply-bridge-smoke.ts`、`scripts/control-protocol-smoke.ts`（3b 组）
- 本文档依据的 SDK：`~/.config/opencode/node_modules/@opencode/{plugin,client,schema,protocol}`
