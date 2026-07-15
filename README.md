# Hao Work

Hao Work 是一个以 [OpenChamber](https://github.com/openchamber/openchamber) 为 UI 与桌面壳基础、以 [HaoCode](https://github.com/skvdhshuk-blip/hao-code) 为 Agent 引擎的 AI 编程工作台。

它的长期方向是成为“模型自适应工作内核”：为不同模型加载经评测验证的 system prompt、工具组合、思考参数、上下文策略和验证流程，而不把产品绑定在某种语言或单一模型上。

它保留 OpenChamber 成熟的会话、文件、工具调用、权限确认、终端和桌面交互体验，但本地运行不再启动 OpenCode。浏览器仍使用 OpenCode SDK 的数据形状，Hao Work 在服务端通过一个兼容层把这些请求翻译为 HaoCode SDK 调用。

<p align="center">
  <img src="docs/images/hao-work-analysis.png" alt="Hao Work 使用 HaoCode 分析 PHP 源码" width="100%">
</p>

## 当前能力

- HaoCode 持久会话、多轮对话和流式文本/思考输出
- Read、Write、Edit、apply_patch、Glob、Grep、Bash、Skill 与 Memory 等工具事件展示
- Bash、文件写入和编辑操作的权限确认
- AskUserQuestion 问答与中断后继续执行
- Anthropic、OpenAI 和 DeepSeek API Key 配置
- 项目、会话和消息状态持久化到 `~/.config/hao-work`
- macOS、Windows 与 Linux 的 Electron 打包结构

兼容层目前只实现 Hao Work 主链路所需的 OpenCode API。OpenChamber 中依赖 OpenCode 专有后端能力的边缘功能可能尚未映射，新增映射时应在 `packages/web/server/lib/haocode/compat-server.test.js` 补回归测试。

## 架构

```text
OpenChamber React UI
        │ OpenCode-shaped HTTP / SSE / WebSocket
        ▼
HaoCode compatibility server (Node.js)
        │ one JSON request + JSON-lines events
        ▼
PHP bridge worker
        │
        ▼
sk-wang/hao-code
```

- `packages/ui`：沿用并扩展 OpenChamber 的 React UI。
- `packages/web/server/lib/haocode`：HaoCode 兼容服务、状态存储与 PHP worker 管理。
- `packages/haocode-bridge`：PHP 与 Node.js 之间的 JSON-lines 边界。
- `packages/electron`：桌面壳、图标和内置运行时打包。

## 本地开发

要求：Bun、Node.js 22+、Composer，以及 PHP 8.3+。

```bash
bun install
composer install --working-dir=packages/haocode-bridge
bun run dev
```

默认页面为 `http://127.0.0.1:5180`，API 服务为 `http://127.0.0.1:3902`。在 Settings → Providers 中保存 Anthropic、OpenAI 或 DeepSeek API Key 后即可创建会话。

开发时可覆盖 bridge 运行环境：

```bash
HAOWORK_PHP_BINARY=/absolute/path/to/php \
HAOWORK_HAOCODE_WORKER=/absolute/path/to/worker.php \
HAOWORK_HAOCODE_AUTOLOAD=/absolute/path/to/vendor/autoload.php \
bun run dev
```

## 测试

```bash
bun test packages/web/server/lib/haocode/compat-server.test.js
bun run type-check
bun run --cwd packages/web build
```

兼容层测试使用假 worker，不消耗模型额度；真实模型联调需要在本地 Provider 设置中保存 API Key。

## 桌面运行与打包

```bash
# Electron 开发模式
bun run electron:dev

# 准备当前平台的轻量 PHP + HaoCode bridge
bun run --cwd packages/electron prepare:haocode-runtime

# 完整打包
bun run electron:build
```

`prepare:haocode-runtime` 会执行以下操作：

1. 按 `packages/haocode-bridge/composer.lock` 安装 HaoCode。
2. 从 NativePHP `php-bin` 下载与当前平台/架构匹配的静态 PHP 8.4，并用 GitHub blob SHA 校验。
3. 把 PHP、bridge、Composer vendor 和运行清单写入 Electron resources。

这些资源只在构建阶段生成，不提交到 Git。最终用户安装打包产物后，不需要另装 OpenCode、Tokimo、Composer 或系统 PHP。

## Provider 环境变量

Hao Work 优先使用在界面中保存的本地 API Key，也兼容以下环境变量：

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`

密钥只保存在本机运行状态中，不要写入仓库或发布产物。

## 致谢与许可

Hao Work 基于 OpenChamber 二次开发，并保留其 MIT License 与原作者版权声明。Hao Work 新增的 HaoCode 集成同样按本仓库的 MIT License 发布。
