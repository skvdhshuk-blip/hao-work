# Hao Work OpenChamber Migration Plan

## Objective

Use OpenChamber as the Hao Work desktop application baseline while replacing the managed OpenCode engine with the PHP HaoCode SDK.

## Reused surfaces

- React application shell, themes, session sidebar, composer, and message rendering.
- Electron shell, runtime URL resolution, terminal, Git, diff, file preview, relay, and update infrastructure.
- Existing OpenCode-shaped client types and browser event reducer as a compatibility boundary.

## Modified surfaces

- Replace the OpenCode process lifecycle and generic API proxy with an in-process HaoCode compatibility API.
- Translate HaoCode text, thinking, tool, interrupt, error, and result events into existing session/message/part/status events.
- Replace provider and model configuration with HaoCode-supported Anthropic, OpenAI Responses, and OpenAI Chat-compatible settings.
- Rename application metadata and visible branding to Hao Work while preserving upstream MIT attribution.

## New surfaces

- A Node.js worker supervisor under `packages/web/server/lib/haocode/`.
- A PHP JSON-lines worker under `packages/haocode-bridge/` using `sk-wang/hao-code`.
- Durable adapter session metadata and OpenCode-compatible message snapshots.
- Build scripts that stage a target PHP runtime, Composer vendor tree, and the matching lightweight sandbox runner.

New compatibility fields use the `_fe_` prefix, including `_fe_agentEngine`, `_fe_haocodeSessionId`, `_fe_phpRuntime`, and `_fe_sandboxStatus`.

## First usable release

1. Boot without an OpenCode installation.
2. Select and inspect a project directory.
3. Configure provider, base URL, model, and API key locally.
4. Create, resume, rename, archive, and delete sessions.
5. Stream text, thinking, tool start/result, errors, and completion state.
6. Abort a running session.
7. Resolve tool approval and `AskUserQuestion` interrupts.
8. Preserve Git, diff, terminal, skills, and memory surfaces where HaoCode supports them.
9. Package a self-contained macOS arm64 application.

OpenCode-only upgrade, OAuth, Zen quota, plugin, and session-sharing controls are hidden until an honest HaoCode equivalent exists.

## Acceptance tests

1. Launch with no OpenCode binary and reach the main workspace.
2. Select a directory and observe its files, Git status, and sessions.
3. Configure a DeepSeek-compatible provider and receive incremental text.
4. Observe Read/Bash tool input, running state, and result.
5. Approve and reject a Bash interrupt and observe the corresponding continuation.
6. Answer `AskUserQuestion` and continue the same durable session.
7. Abort an active run and observe the session return to idle.
8. Restart and continue an existing conversation.
9. Run two sessions without cross-routing events.
10. Surface provider, empty-response, and worker-crash failures visibly.
11. Pass web, Electron HMR, and Electron bundled-mode checks.
12. Run the packaged macOS arm64 app without system PHP or OpenCode.
