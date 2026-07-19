# 三项任务执行计划

仓库：`/Users/wanghao/git/hao-work`（基于 OpenChamber 的 hao-work monorepo，HaoCode PHP SDK 替换 OpenCode 引擎）

## 任务分解

### 任务 1：更新 hao-code 依赖版本
- 现状：`packages/haocode-bridge/composer.json` 要求 `sk-wang/hao-code ^1.10.2`，lock 锁定 v1.10.2（git 源 https://github.com/skvdhshuk-blip/hao-code.git）
- 执行：查明最新 tag → 评估变更 → 更新 composer.json/lock → 适配 worker.php 与 Node 桥接层（如有破坏变更）→ 跑 bridge/compat-server 测试
- 技能：`openchamber-change-discipline`

### 任务 2：设计自动判断是否需要 HITL 的模式
- Stage A（并行于任务 1/3）：HITL 架构设计师调研全链路（PHP worker → worker-supervisor → compat-server → UI 审批组件 → 设置持久化；含 vendor/sk-wang/hao-code 的权限回调 API），产出设计文档 `docs/plans/haocode-auto-hitl-design.md`（只写文档，不改源码）
- Stage B（Stage A 完成后）：实现工程师按设计文档实现（server 参数传递、PHP worker 风险分级回调、UI 模式切换与可视反馈、测试）
- 技能：`openchamber-change-discipline`、`ui-api-decoupling`、`settings-ui-patterns`（实现阶段按需）

### 任务 3：GUI 科技感风格优化
- 范围：仅 `packages/ui` 的样式/主题/组件视觉，不改布局结构与组件 API，不加依赖
- 技能：`theme-system`（必读）、`openchamber-change-discipline`
- 验证：type-check / lint / build:ui

## 阶段门
1. Swarm 1（并行 3 个 coder）：任务1实现 + 任务2设计文档 + 任务3实现
2. 检查各产出 → 不合格则补充指令重派
3. Swarm 2：任务2实现（读设计文档）+ 必要的修复工人
4. 终验：聚焦测试 + type-check，汇总汇报
