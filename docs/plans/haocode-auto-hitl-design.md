# HaoCode 自动 HITL（人工介入）模式设计

> 状态：设计稿（未实施） · 作者：HITL架构设计师 · 日期：2025-07
> 范围：仅设计，不含任何源代码改动。涉及 `packages/haocode-bridge`、`packages/web/server/lib/haocode`、`packages/web/server`（auto-accept 先例）、`packages/ui`。

> **实施更正（2026-07，以代码为准）**：本文 §4.3 的调研结论“SDK 无 per-call 决策回调，按参数自动决策只能放在 compat-server”已**作废**。最终实施将 smart 档的决策点下沉到了 **PHP worker**（`packages/haocode-bridge/worker.php`）：worker 在 smart 模式下按规则分级 + 灰区模型评审自动决策，每个被自动决策的 action 向 server 发一行 `auto_decision` 事件后**同进程续跑**（不再走 server 侧预填 decisions + `resume_interrupt` 的路径）。Node compat-server 的职责相应收窄为：配置下发（stdin 请求携带 `hitlMode` / `hitlReviewModel`）与自动决策可视化（`auto_decision` → SSE `permission.auto_resolved` + `state.autoDecisions` 审计持久化）。事件形状与配置契约以 `packages/web/server/lib/haocode/DOCUMENTATION.md` 的“Human-in-the-loop”段落为准；terminalEvent 契约（每次 run 以 `result`/`error`/`interrupt` 之一收尾）不变。本文其余章节（模式语义、风险分级思路、UI 方案）仍具参考价值，但 §4.2/§4.3 的 server 侧挂载点描述不再反映实现。

---

## 1. 现状链路

### 1.1 端到端流程（文字版）

1. **用户发消息**：UI 调 `POST /session/:sessionID/prompt_async`（compat-server.js）。server 写入 user 消息、创建 assistant 占位消息，置 session 状态 `busy`，然后 `supervisor.run()` 启动一个**短生命周期 PHP 进程**（`packages/haocode-bridge/worker.php`）。
2. **Node → PHP 参数传递**：`worker-supervisor.js` 把整个 request（`action: 'run'`、`prompt`、`cwd`、`provider`、`haocodeSessionId`、`storagePath`、`mcpSettingsPath` 等）以 JSON 写入 PHP 进程 stdin。worker.php 用它构造 `HaoCode\Sdk\HaoCodeConfig`，关键参数：
   - `permissionMode: 'bypass_permissions'`（**硬编码**，SDK 的 `PermissionChecker` 因此对所有工具直接 `allow()`，SDK 自带的 allow/deny 规则与 `DangerousPatterns` 全部不生效）；
   - `interruptOn`：compat-server 目前**不传**，worker.php 默认对 `Bash` / `Write` / `Edit` / `apply_patch` 四个工具配置中断（`allowedDecisions: ['approve','edit','reject']`）；
   - `enableAskUser: true`（`AskUserQuestion` 始终产生 interrupt）。
3. **PHP worker 产生 interrupt**：SDK `AgentLoop` 每轮对工具调用批次执行 `ToolOrchestrator::prepareHumanReview()`；`prepareOneForHumanReview()` 中命中 gate（`$decision->needsPrompt || $configured !== false || AskUserQuestion`，ToolOrchestrator.php:625-630）的工具被包装为 `HumanActionRequest`，整批打包成 `HumanInterrupt` 存入 SDK `SessionManager` 并抛 `HumanInterruptException`。worker.php 将其作为一行 JSON 事件 emit：`{ type: 'interrupt', interrupt: { id, session_id, actions: [{ id, tool_name, input, description, allowed_decisions, agent_id }], ... } }`，随后 **PHP 进程退出**。
4. **server 落 pending**：compat-server `handleWorkerEvent` 收到 `interrupt` 后调 `createPendingInterrupts()`：
   - `state.interrupts[interrupt.id] = { id, sessionId, haocodeSessionId, directory, actions, decisions: {} }`（存 runtime-state.json）；
   - 每个 action 按 `tool_name` 分流：`AskUserQuestion` → `state.questions` + SSE `question.asked`；其余 → `state.permissions` + SSE `permission.asked`；
   - assistant 消息标记 `finish: 'interrupt'`，session 转 `idle`。
5. **UI 审批**：UI event-reducer 处理 `permission.asked` / `question.asked` 写入 zustand store，`PermissionCard` / 问题卡渲染；用户点击后调 `POST /permission/:requestID/reply { reply: 'once'|'always'|'reject' }` 或 `POST /question/:requestID/reply { answers }`（拒绝走 `/reject`）。
6. **resume 续接**：compat-server `resolveInterrupt()` 把回复翻译成 SDK `HumanDecision` 形状写入 `interrupt.decisions[actionId]`（approve / reject / respond），并从 pending 列表移除。**当该 interrupt 的全部 action 都有 decision 时**，删除 `state.interrupts[id]`，立即 `startRun({ request: { action: 'resume_interrupt', interruptId, haocodeSessionId, decisions } })` —— 再起一个 PHP 进程，走 `HaoCode::streamResumeInterrupt()` 恢复执行，事件流继续（`tool_start` → `tool_result` → … → `result`）。

### 1.2 现状要点（对本设计的约束）

- **一次 interrupt 可含多个 action**（同一批工具调用），必须凑齐全部 decisions 才续跑 —— 这是"部分自动放行 + 部分人工"的天然挂载点。
- **pending 存于 server store 并持久化**（runtime-state.json，0600），重启后可恢复。
- **adapter 自有字段一律 `_fe_` 前缀**（DOCUMENTATION.md 约定），SSE 事件形状为 `{ id, type, properties }`，未知事件类型 UI reducer 默认忽略。
- **已有先例：OpenChamber 原生 permission auto-accept**（`packages/web/server/lib/permission-auto-accept/runtime.js`）：server 侧订阅全局事件流上的 `permission.asked`，若 session（含父链）开了 auto-accept，自动 POST `/permission/:id/reply { reply: 'once' }`；带 0/250/1000ms 重试、404 容忍（竞态：用户先点了）、`openchamber:permission-auto-accept.updated` 广播。该机制通过 OpenCode HTTP 契约工作，**在 haocode 模式下今天已经可用**（compat-server 暴露了对应路由），UI 入口是 ChatInput 的 `PermissionAutoAcceptButton`（per-session 开关，经 `/api/permission-auto-accept/sessions/:id` 与 `/api/notifications/auto-accept` 持久化到 OpenChamber server settings）。
- SDK 侧可挂载点（真实签名，见 §4.3）集中在 `HaoCodeConfig` 与 settings 文件两处；**SDK 没有暴露 per-call 的 `canUseTool` 决策回调**（`ToolOrchestrator::setPermissionPromptHandler(callable)` 存在但不是公开 config API，worker.php 够不着）。

---

## 2. 设计目标与非目标

### 目标

1. 提供 **ask / smart / auto 三档 HITL 模式**，用户可全局切换，server 端持久化并对所有运行表面（web/desktop/VS Code/mobile 经同一 compat-server）一致生效。
2. **smart 档按"工具 × 参数"风险分级自动放行低风险操作**，规则具体、可测、fail-closed（拿不准就问）。
3. **安全决策在 server 核心逻辑强制**（compat-server / worker 参数层），不是 UI 隐藏按钮；UI 只负责切换与可视反馈。
4. 自动放行**全程可见**：发生什么、为什么放行，UI 有记录；误判有可理解的回退路径。
5. 改动最小化：**不改 vendor 内 SDK**，不改 PHP worker 的既有事件协议（仅新增可选入参）。

### 非目标

- 不实现基于 LLM 的"智能审批"（smart 档是确定性规则分级，不引入二次模型调用）。
- 不做 per-session / per-directory 粒度覆盖（可作为后续增强；现有 per-session auto-accept 机制保持可用）。
- 不改动 SDK vendor 代码、不改 `../opencode`；如需 SDK 级回调（如 `canUseTool`）仅列为上游建议。
- 不处理 MCP 工具的细粒度策略（v1 一律按高风险处理）。
- 不引入新 npm/Composer 依赖。

---

## 3. 模式定义

### 3.1 三档语义

| 档位 | 语义 | 实现要点 |
|---|---|---|
| `ask` | **每个都问**（现状，默认） | 保持现状：worker 默认 `interruptOn`（Bash/Write/Edit/apply_patch）+ `AskUserQuestion` 全走 UI 审批。现有 per-session auto-accept 仍可叠加。 |
| `smart` | **自动判断**：低风险动作 server 自动 approve 并立即续跑，高风险动作照常走 UI 审批 | interrupt 仍由 PHP 产生；compat-server 在 `createPendingInterrupts` 前对每个 action 跑风险分级器（§3.2），低风险 action 的 decision 预填为 `approve`，不产生审批卡；高风险 action 照常 pending。 |
| `auto` | **全部自动放行**（工具审批全免） | server 向 worker 传 `interruptOn: []`（PHP 根本不为工具产生 interrupt），`enableAskUser` 保持 `true` —— **AskUserQuestion 仍然问**（它不是"权限"，是代理向用户要信息，自动答会污染对话且无意义）。工具执行在 UI 时间线照常可见（`tool_start`/`tool_result`），只是没有审批卡。 |

三档共同红线：**`AskUserQuestion` 任何档位都问人**。

### 3.2 smart 档风险分级规则

分级器为 server 侧**纯函数**：`classifyAction(action: { tool_name, input, description }, ctx: { directory }) → { level: 'auto' | 'ask', reason: string }`。规则按顺序求值，**第一条命中即生效；黑名单永远优先于白名单；任何异常/不识别一律 `ask`**（fail-closed）。

**R0 · 结构与来源红线（最先检查，命中即 `ask`）**
- `tool_name` 不在已知清单内（含所有 `mcp__*` / MCP 工具）→ `ask`。
- `action.allowed_decisions` 不含 `approve` → `ask`（如子代理等待类的 `respond/reject` 专属 action）。
- `input` 不是预期形状（如 Bash 缺 `command` 字符串）→ `ask`。

**R1 · 凭证与敏感路径红线（命中即 `ask`，任何工具）**
- 路径或命令文本涉及：`~/.ssh`、`~/.aws`、`~/.gnupg`、`**/.env`、`**/credentials*`、`**/id_rsa*`、`**/*.pem`、`**/*.key`、runtime-state.json（适配器自己的密钥文件）、macOS Keychain 路径等。
- Bash 命令读/写上述路径，或含 `security find-generic-password`、`cat ~/.netrc` 等取密模式 → `ask`。

**R2 · 只读工具 → `auto`**
- `Read` / `Glob` / `Grep` / `LSP`（注意：这四个工具当前本来就不在 worker 默认 `interruptOn` 里，不会产生 interrupt；规则写上是为防御未来 interruptOn 扩大）→ `auto`，但仍受 R1 约束（例如 `Read ~/.ssh/id_rsa` → `ask`）。

**R3 · 文件写入类（`Write` / `Edit` / `apply_patch`）**
- 目标路径解析（相对路径基于 `ctx.directory`，含 `..`、`~` 展开与 symlink 收敛，复用 compat-server `resolveUnderDirectory` 同款思路）：
  - **解析失败或越出 session 工作区根** → `ask`（越界必问）；
  - 命中 R1 敏感路径 → `ask`；
  - 覆盖二进制/超大文件（input.content 超过阈值，如 1MB）→ `ask`；
  - 其余（工作区内常规源码/文档写入）→ `auto`。

**R4 · Bash 命令分级**（对 `input.command` 做静态文本分析，**不做 shell 解析**，拿不准就升级）
- **必问黑名单（命中即 `ask`）**：
  - 破坏与删除：`rm -rf`/`rm -fr`、`rm -r` 作用于非工作区路径、`mkfs`、`dd`、`> /dev/sd*`、`shred`；
  - git 外发与历史改写：`git push`（含 `--force`）、`git reset --hard`、`git clean -f[d]`、`git rebase`、`git commit`（提交属外发语义，v1 保守列入必问，可拍板放宽）、`git checkout -- .`；
  - 网络外发：`curl` / `wget` / `nc` / `scp` / `rsync`（含 `curl … | sh` 管道执行）、`ssh`、`openssl s_client`；
  - 提权与系统：`sudo`、`chmod 777`/`000`、`chown`、`launchctl`、`systemctl`、`crontab`、写 `/etc`、`/usr`、`/System`、`~/.zshrc` 等启动文件；
  - 凭证/环境窃取：R1 模式、`env` 全量打印、`printenv`、`cat /proc/*/environ`、`history`；
  - 混淆与任意执行（对齐 SDK `DangerousPatterns::checkObfuscation()` / `isCodeExecCommand()`）：`` $()` ``、反引号、`${}`、`eval`、`base64 -d | sh`、`xargs` 执行、控制字符；
  - 包管理副作用：`npm publish`、`bun publish`、`pip install`（写全局环境；`npm install`/`bun install` 写工作区 node_modules，列入白名单候选，可拍板）。
- **白名单 → `auto`（须整条命令匹配，含管道/`&&`/`;` 连接的每一段都白名单才放行）**：
  - 导航/查看：`pwd`、`ls`、`cat`、`head`、`tail`、`wc`、`file`、`stat`、`du`、`df`、`tree`、`which`、`echo`、`printf`、`date`；
  - 搜索：`grep`、`rg`、`find`（不含 `-exec`/`-delete`）；
  - git 只读：`git status`、`git log`、`git diff`、`git show`、`git branch`（不带 `-d/-D/-m`）、`git rev-parse`、`git ls-files`、`git blame`；
  - 开发只读/工作区内：`php -v`、`php -l`、`composer show|validate`、`node -v`、`bun -v`、`npm ls`、`tsc --noEmit`、`bun test`、`bun run test|type-check|lint`（测试/lint 可能写覆盖率缓存，属工作区内可逆副作用 → `auto`，可拍板）；
  - `mkdir`/`touch`/`cp`/`mv` **且所有路径参数解析后都在工作区内** → `auto`。
- **其余一律 → `ask`**（默认拒绝自动放行；白名单宁可窄）。

**R5 · 其他工具**
- `TodoWrite` / `MemoryRead` / `MemoryWrite` / `Skill`：当前不在默认 `interruptOn` 内（无 interrupt）；防御性规则 `auto`（MemoryWrite 写的是适配器隔离存储）——若未来纳入 interrupt 则 `TodoWrite`/`MemoryRead` auto，`MemoryWrite`/`Skill` ask（可拍板）。
- `AskUserQuestion`：**永远 `ask`**（三档通用红线，见 §3.1）。

### 3.3 误判回退与安全红线

1. **fail-closed**：分级器抛异常、输入形状未知、路径解析失败 → `ask`；server 配置缺失/损坏 → 视为 `ask`。
2. **黑名单优先**：任何白名单匹配前先过黑名单；命令被分段（`&&`/`|`/`;`）时每段独立过规则，一段必问则整条必问。
3. **红线在 server 强制**：分级器与 `interruptOn` 参数都在 compat-server / worker 入参层（核心逻辑），UI 不掌握绕过通道；`auto` 档也只是"server 不再要求 PHP 中断"，不是"UI 藏起按钮"。
4. **误判回退路径**：
   - 用户发现 smart 放行过宽 → 一键切回 `ask`（立即生效于后续 run；已在途的 interrupt 按发起时快照处理，见 §4.5）；
   - 每次自动放行都带 `reason` 记录（§4.4），可审计；
   - 文档化"窄白名单"原则：新命令默认必问，按使用证据逐步加白。
5. **安全红线（任何档位不自动放行）**：R1 凭证路径、R4 必问黑名单、`AskUserQuestion`。`auto` 档的残余风险如实告知用户（见 §6 拍板项 P2）。

---

## 4. 端到端方案

### 4.1 配置存储与 API

- **存储**：复用 compat-server 已有的 `state.config`（store.js 已持久化到 runtime-state.json，0600；`PATCH /config` 路由已存在，做 merge 写入）。新增字段（`_fe_` 前缀符合 adapter 约定）：
  - `_fe_hitlMode: 'ask' | 'smart' | 'auto'`（缺省 = `ask`）。
- **读取**：`GET /config` / `GET /global/config` 已原样返回 `state.config`，UI 经现有 config 通道即可读到。
- **写入**：UI 调 `PATCH /config { _fe_hitlMode: 'smart' }`。server 侧校验枚举值，非法值 400。
- **多端同步缺口（需在实施时补）**：当前 compat-server `PATCH /config` **不 publish 事件**，多窗口/多客户端不会实时收到模式变更。实施时在 PATCH 后 `publish(directory, event('config.updated', { … }))`（OpenCode 契约已有 `config.updated` 事件形状，UI reducer 支持情况需在 UI 阶段核实；不支持则由 UI 在写入成功后本地更新 store，接受其他窗口下次刷新同步）。
- 备选方案（不推荐）：存 OpenChamber server settings（permissionAutoAccept 先例）。缺点：compat-server 是被 `index.js` 组合的独立模块，拿不到 OpenChamber settings，需要新增跨模块配置管道；而 `state.config` 是 compat-server 自持有、`runSession` 直接可读，链路最短。

### 4.2 server → PHP worker 参数传递

`runSession` 发起 run 前读 `store.getConfig()` 取模式，按档构造 request（worker.php 已支持这两个入参，**worker.php 零改动或仅一行默认调整**）：

| 档位 | `request.interruptOn` | `request.enableAskUser`（当前硬编码 true，可不动） |
|---|---|---|
| `ask` | 不传（worker 默认四工具） | true |
| `smart` | 不传（仍由 PHP 产生 interrupt，server 决策） | true |
| `auto` | `[]`（`normalizeInterrupts([])` 返回空数组 → `HaoCodeConfig interruptOn: []` → 工具不产生 interrupt） | true（AskUserQuestion 仍问） |

要点：
- `worker.php` 的 `normalizeInterrupts()` 对 `is_array` 的输入原样透传，空数组合法；`HaoCodeConfig` 构造器对空 `interruptOn` 无异常（仅校验 `ephemeral` 与 interrupt 组合，本适配器 `ephemeral: false`）。
- resume 路径无需额外参数：SDK `HumanInterruptCoordinator::resolve()` 经 `restoreCheckpointPolicy()` 从 checkpoint 恢复**发起时**的 `interrupt_on`，即 pending interrupt 按发起时模式结算 —— 行为一致、可解释。
- `resume_interrupt` 请求里 compat-server 已传 `decisions`，形状 `{ action_id, type: 'approve' | 'reject' | 'respond', message?, response? }`（compat-server.js:650-654），自动放行复用同一形状（`type: 'approve'`）。

### 4.3 SDK 回调挂载点（调研结论，引用真实签名）

worker.php 只使用 SDK 公开 API。经逐文件核实，可用挂载点如下：

1. **`HaoCode\Sdk\HaoCodeConfig::__construct(...)`**（app/Sdk/HaoCodeConfig.php）
   - `permissionMode: string = 'default'` —— 当前 worker 硬编码 `'bypass_permissions'`，它使 `PermissionChecker::check()` 在第一行 `return PermissionDecision::allow()`，**SDK 策略层整体短路**。
   - `interruptOn: array = []` —— 按工具名的静态中断配置（`true/false/{allowedDecisions, description}`），**当前唯一的 HITL 触发源**。本设计三档都通过它控制"是否产生 interrupt"。
   - `allowedTools: array` / `disallowedTools: array`（`toolFilter(): ?callable`，签名 `fn(string $toolName): bool`）—— 工具级开关，不能按参数决策。
   - `enableAskUser: bool` —— `AskUserQuestion` 中断开关。
2. **settings 文件注入**（worker.php 已用 `HAOCODE_GLOBAL_SETTINGS_PATH` env 指向 server 生成的 JSON，现承载 `mcp_servers`）：
   - `SettingsManager::getAllowRules() / getDenyRules()` 读 `permissions.allow` / `permissions.deny`（规则 DSL：`Bash(git status:*)`、`Write(/abs/path/*)`，`PermissionChecker::matchesRule()` 支持 `prefix:*` 与 `fnmatch`）；`getPolicyFiles()` 读 `permissions.policy_files`（YAML execpolicy，SDK 自带 `policies/default.yml` 示例，含 `allow_auto` / `ApprovalRequired` / `Deny`）。
   - **但**：`permissionMode = bypass_permissions` 时 `PermissionChecker::check()` 直接 allow，以上全部不生效。启用 SDK 策略层需要切回 `'default'` 模式，届时**所有非只读工具默认 `ask()` → `needsPrompt` → 必然 interrupt**（ToolOrchestrator.php:626-630），等效"比 ask 档更宽的全问"。因此本设计**不采用** SDK 策略层做主路径；它作为可选加固列入拍板项（P2）。
3. **不存在的挂载点（如实说明）**：
   - 无 per-call `canUseTool(toolName, input) → bool` 回调。`ToolOrchestrator::setPermissionPromptHandler(callable $handler)`（签名 `fn(string $toolName, array $input): bool`）是内部 API，worker.php 经 `HaoCode::stream()` 公开入口无法注入。
   - 因此"按参数自动决策"**只能放在 compat-server**（interrupt 事件已经带完整 `tool_name` + `input` + `allowed_decisions`，信息充分）。这也正是本设计的主挂载点。

**主挂载点（server 侧）**：`compat-server.js` 的 `createPendingInterrupts({ session, assistantId, interrupt })` 与 `resolveInterrupt({ requestId, reply, answers })` 之间。smart 档在 `createPendingInterrupts` 内对每个 action 调分级器：

- `level === 'ask'` → 现状不变：写 `state.permissions` / `state.questions` + publish asked 事件；
- `level === 'auto'` → **不写 pending、不发 asked**；在同一 `store.mutate` 事务内预填 `state.interrupts[id].decisions[actionId] = { action_id: actionId, type: 'approve' }`；记录自动放行日志并 publish `permission.auto_resolved` 事件（§4.4）；
- 全部 action 自动放行 → `decisions` 已齐，直接复用现有续跑逻辑（抽出 `resolveInterrupt` 中"凑齐即续"的尾段为共用函数，`startRun({ action: 'resume_interrupt', … })`）；
- 部分自动 → 等人工 action 回复后，`resolveInterrupt` 现有的"`actions.every(decisions)` 凑齐"判断自然成立，零特判。

### 4.4 自动放行的可见性（事件与消息）

新增一个 adapter 自有 SSE 事件（不污染 OpenCode 契约，UI 未知事件默认忽略，旧 UI 安全）：

```
type: 'permission.auto_resolved'
properties: {
  sessionID, directory,
  requestID: `req_${action.id}`,
  permission: action.tool_name,
  metadata: { input: action.input, description: action.description,
              _fe_interruptId, _fe_actionId, _fe_reason: 分级器给出的 reason },
  reply: 'once',
  time: Date.now()
}
```

- **持久化**：`store.mutate` 内追加到 `state.autoDecisions`（新数组，每 session 环形保留最近 N=100 条：`{ id, sessionId, directory, tool, input, reason, time }`），runtime-state.json 重启后仍可审计；新增 `GET /permission/auto-resolved?directory=` 只读路由（或并入 `/permission` 响应的 `_fe_` 字段）。
- **UI 渲染**：session 时间线/审批区显示一条低饱和度"已自动放行 · Bash: `git status`（只读命令白名单）"记录，可折叠；提供"切换到每个都问"快捷入口。
- **不采用**的方案：publish `permission.asked` 后紧跟 `permission.replied` —— reducer 先插后删会闪烁，且与真实人工回复不可区分；故用独立事件。

### 4.5 中断与竞态处理

1. **自动放行 vs 用户点审批**：自动放行的 action **从不进入** `state.permissions`，UI 根本不会出现它的审批卡 —— 该竞态在结构上被消除。人工 action 的卡只有人能点，decision 唯一写入方清晰。
2. **用户回复与自动续跑的先后**：全部决策与续跑判断都在 `store.mutate` 串行队列内完成（store 写入本就串行化），"凑齐即续"只发生一次；`resolveInterrupt` 对已删除的 pending 返回 `null` → 路由 404，UI 忽略即可（permission-auto-accept runtime 已有同款 404 容忍先例）。
3. **模式切换瞬间**：配置在 `runSession` 启动时读取一次（快照），在途 run 与已 pending 的 interrupt 按发起时模式结算（checkpoint 恢复 `interrupt_on`，见 §4.2）；新 run 用新模式。**不回溯自动放行已 pending 的请求**（保守：已经问出口的必须问完）——唯一例外是用户手动把某 pending 回复掉，现状逻辑。
4. **auto 档与 in-flight interrupt 交错**：auto 档 run 不产生工具 interrupt；若上一 ask 档 run 的 interrupt 还 pending，`POST /session/:id/prompt_async` 已被 `supervisor.isRunning` / UI 阻塞语义覆盖，不会混淆（resume 是独立 action）。
5. **abort**：`POST /session/:id/abort` 杀 PHP 进程；smart 自动续跑同样是一个受 supervisor 管理的 run，abort 路径不变。
6. **PHP 崩溃/异常退出**：现状 `terminalEvent` 兜底（"worker completed without a final result" → error）不变；自动放行不会让 server 等待不存在的事件。

### 4.6 UI 方案

- **模式切换入口**：ChatInput 工具栏、现有 `PermissionAutoAcceptButton` 旁，新增三档分段控件（`每个都问 / 智能放行 / 全部自动`；图标沿用安全/闪电语义，文案走 i18n，遵循 `locale-ui-patterns` 与 `settings-ui-patterns` skill）。点击写 `PATCH /config { _fe_hitlMode }` 并乐观更新本地 config store；失败回滚并 toast。
  - 与 per-session auto-accept 的关系（需在 UI 文案说清）：auto-accept 是"本会话全放行"的旧机制，三档是全局模式；`auto` 档上线后 UI 可将 auto-accept 按钮标注为"已被全局模式覆盖"或保留并存（拍板项 P5）。
- **自动放行可视反馈**：event-reducer 新增 `permission.auto_resolved` case → 写入新 store（按 session 存最近 N 条，配合 §4.4 持久化做 bootstrap）；聊天流中渲染"已自动放行"条目（工具名 + 命令/路径摘要 + reason + 时间），样式低饱和、可展开看完整 input；设置里可选"自动放行时发桌面通知"（复用 notifications 通道，默认关）。
- **模式指示**：输入框附近常驻小徽标显示当前档位（避免用户忘记自己开过 auto）。

---

## 5. 测试计划与分阶段实施

### 阶段 1 · Node 侧：配置与 auto 档（最小闭环）

- compat-server：`_fe_hitlMode` 读取/校验/默认值；`runSession` 按档传 `interruptOn`（auto → `[]`）；PATCH `/config` 后 publish `config.updated`。
- 测试（`compat-server.test.js`，沿用 fake-worker 夹具模式）：
  - auto 档：fake worker 断言收到的 `request.interruptOn` 为 `[]`（仿 `request-config` 分支回显）；
  - ask/缺省档：不传 `interruptOn` 字段；
  - `PATCH /config` 非法值 400、合法值 round-trip（GET 读回）。
- PHP 侧：`worker.test.mjs` 补一条 `interruptOn: []` 透传用例（`normalizeInterrupts` 空数组语义），无需真跑 SDK。

### 阶段 2 · Node 侧：smart 分级器与自动续跑

- 新模块 `packages/web/server/lib/haocode/hitl-policy.js`：**纯函数** `classifyAction(action, { directory })`（§3.2 全部规则，含路径解析/命令分段），独立单测覆盖 R0–R5 每条规则与 fail-closed 分支（黑名单优先、分段命令、越界路径、凭证路径、异常输入）。
- compat-server：`createPendingInterrupts` 接入分级器（§4.3）；抽出"凑齐即续"共用函数；`permission.auto_resolved` 事件 + `state.autoDecisions` 持久化 + 只读路由。
- 测试（fake-worker 已有 `interrupt` / `multi-interrupt` 夹具，直接扩展）：
  - 单 action 低风险（`Bash pwd`）：无 `/permission` pending、自动 `resume_interrupt` 续跑、fake worker 收到 `decisions: [{ type: 'approve' }]`、`permission.auto_resolved` 事件发出；
  - 单 action 高风险（`Bash rm -rf /`）：pending 照常、不自动续；
  - 多 action 混合（`multi-interrupt`：一低一高）：低风险无卡、高风险有卡，人工回复后凑齐续跑，decisions 含预填 approve；
  - 越界 `Write /etc/x` → ask；工作区内 `Write src/a.ts` → auto；
  - `AskUserQuestion` 任何档位都 pending（question 夹具复用）；
  - 分级器抛错注入 → 该 action 降级 ask；
  - 竞态：自动放行后对同一 `requestID` 调 reply 路由 → 404 且不崩。

### 阶段 3 · UI 侧：切换入口与可视反馈

- ChatInput 三档控件 + config store 读写 + 乐观更新/失败回滚；`permission.auto_resolved` reducer + store + 时间线条目；常驻档位徽标；i18n 文案。
- 测试：`event-reducer` 新 case 单测；控件交互组件测试（若仓库有同档先例则沿用）。

### 阶段 4 · 加固与增强（可选，按拍板结果）

- 若拍板启用 SDK 策略层兜底（P2）：worker 生成的 settings JSON 增加 `permissions.deny` 红线清单 + `permissionMode` 调整评估（注意 bypass 短路问题，§4.3-2）。
- per-directory 模式覆盖；自动放行桌面/推送通知；auto-accept 旧机制与三档的统一收口。
- 文档：更新 `packages/web/server/lib/haocode/DOCUMENTATION.md`（interrupt 生命周期新增自动决策段）与本设计的状态标注。

### 各侧分工汇总

- **PHP（worker.php）**：仅透传（已支持）；阶段 4 可能加生成 settings 的 deny 清单。vendor SDK **不动**。
- **Node（compat-server + 新 hitl-policy.js）**：配置存储/校验、按档传参、分级器、自动续跑、auto_resolved 事件与持久化、config.updated 发布。
- **UI（packages/ui）**：三档控件、reducer/store/渲染、徽标与文案。

---

## 6. 不确定点与需要主人拍板的决策

| # | 决策项 | 建议 | 备注 |
|---|---|---|---|
| P1 | **默认档位** | 保持 `ask` 为默认，`smart` 经一个版本观察后再评估是否切默认 | `auto` 永不作为默认 |
| P2 | **`auto` 档的硬红线深度** | v1 接受"工具全放行、AskUserQuestion 仍问"，UI 明示风险；后续如需"Bash 危险命令即便 auto 也拦"，须切 `permissionMode` 离开 bypass 并启用 SDK deny 规则/settings 策略层（改动面变大，且 default 模式会让非白名单写入全变 ask，需连白名单一起做） | 这是"auto 是否绝对放行"的安全边界问题 |
| P3 | **smart 白名单具体清单** | 按 §3.2 R4 起步（窄）；`git commit`、`npm install`、测试/lint 命令是否算 auto 请拍板 | 清单是策略数据，后续可低成本调整 |
| P4 | **配置存储位置** | compat-server `state.config._fe_hitlMode`（本方案） | 备选：OpenChamber server settings（需跨模块管道） |
| P5 | **与 per-session auto-accept 的关系** | v1 并存（auto-accept 只对 `ask` 档有实际效果）；v2 评估收口为同一三档模型 | 两套机制叠加需要文案解释 |
| P6 | **自动放行记录持久化条数与通知** | 每 session 保留 100 条；桌面/推送通知默认关 | — |
| P7 | **子代理（Agent/Team）interrupt 的 smart 处理** | 同一套 R0–R5 规则；`respond/reject` 专属 action（child-wait）一律 ask | 现状 worker 未给子代理开 interruptOn，属防御性规则 |
| P8 | **Write/Edit 工作区边界判定** | 以 `session.directory` 解析后的真实路径为根，越界必问；symlink 逃逸按越界处理 | 与 `/file` 路由 `resolveUnderDirectory` 语义对齐 |
| P9 | **模式作用域** | v1 全局（per dataDir）；per-project 覆盖做阶段 4 增强 | state.config 是全局单例 |
| P10 | **是否向上游 hao-code SDK 提 `canUseTool` 回调需求** | 建议提（签名形态：`fn(string $toolName, array $input): bool \| 'ask'`），有它后 smart 决策可下沉 PHP 侧、auto 档也能保留硬红线 | SDK 是 git 源第三方包，本仓不改 vendor |

---

## 附：关键代码坐标（调研依据）

- `packages/haocode-bridge/worker.php:71-99` — `HaoCodeConfig` 构造（`permissionMode: 'bypass_permissions'`、`interruptOn`、`enableAskUser: true`）；`:177-201` `normalizeInterrupts` 默认四工具；`:91-99` `resume_interrupt` 分支。
- `packages/web/server/lib/haocode/compat-server.js:357-434` `createPendingInterrupts`；`:639-690` `resolveInterrupt`（凑齐 decisions 即续跑）；`:738-742` `PATCH /config`；`:1080-1116` permission/question 路由。
- `packages/web/server/lib/haocode/store.js:5-16` — state 形状（`permissions`/`questions`/`interrupts`/`config`）。
- SDK：`app/Sdk/HaoCodeConfig.php:83`（permissionMode）、`:312`（interruptOn）；`app/Services/Agent/ToolOrchestrator.php:620-668`（interrupt gate 与 `HumanActionRequest` 生成）；`app/Services/Permissions/PermissionChecker.php:36-111`（bypass 短路、allow/deny 规则、DangerousPatterns、只读 auto-allow）；`app/Services/Permissions/DangerousPatterns.php`；`app/Services/Settings/SettingsManager.php:431-450`（`permissions.allow/deny/policy_files`）、`:639-673`（全局+项目 settings 合并）；`app/Services/Agent/HumanInterruptCoordinator.php:24-150`（resolve/claim/续跑）。
- auto-accept 先例：`packages/web/server/lib/permission-auto-accept/runtime.js`（重试、404 容忍、reconcile）；`packages/web/server/index.js:790-801` 接线。
- UI：`packages/ui/src/sync/event-reducer.ts:486-537`（permission/question 事件）；`packages/ui/src/components/chat/PermissionCard.tsx`；`packages/ui/src/components/chat/ChatInput.tsx`（`PermissionAutoAcceptButton`）；`packages/ui/src/stores/permissionStore.ts` + `stores/utils/permissionAutoAccept.ts`。
