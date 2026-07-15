# HaoCode compatibility runtime

This module keeps the OpenChamber browser contract stable while replacing the upstream OpenCode process with HaoCode.

- `store.js` persists adapter-owned sessions, OpenCode-shaped message snapshots, pending interrupts, provider settings, and status.
- `worker-supervisor.js` owns one short-lived PHP process per active session. The PHP process is not an HTTP sidecar; it reads one request over stdin and emits JSON-lines events over stdout.
- `compat-server.js` exposes the subset of the OpenCode HTTP/SSE protocol required by the existing UI and translates HaoCode worker events into OpenCode session events.

Project and user Agent/Command definitions remain stored in OpenCode-compatible config files so the inherited settings UI can edit them. The adapter lists those definitions through `/agent` and `/command`; a selected custom agent's prompt is appended to the corresponding HaoCode run. MCP definitions are converted to a private, generated HaoCode settings file for each project and enabled for that worker run. `/mcp` reports whether each definition is enabled and structurally usable; the actual connection is established by HaoCode when a run starts.

HaoCode `TodoWrite` events are persisted per session and published as `todo.updated`. Session diff, VCS diff/status, and file status responses are derived from the selected workspace's current Git worktree. They describe current workspace changes, including changes that predate the session; they are not an attribution ledger. HaoCode's LSP client is created only while the `LSP` tool runs, so `/lsp` correctly has no persistent server process to report even though the tool is available to the agent.

Message history pagination preserves complete renderable turns: a limited page includes any older parent user messages referenced by assistant records in that page, and `x-next-cursor` identifies the next older base page. Supplemental parent records may therefore make a response slightly larger than its requested limit.

Model limits have one runtime source of truth. The compatibility server resolves each model's context and output limits from the shared models.dev catalog, exposes those values through `/config/providers`, and sends the same values to the PHP worker. When the catalog is unavailable and no stale cache exists, it falls back to HaoCode's `200000` context and `16384` output defaults. The worker applies the resolved context through `HAOCODE_CONTEXT_WINDOW`, so the provider page, Context sidebar, and HaoCode compaction budget use the same limits.

Shutdown is a drain operation: the compatibility server terminates workers, waits for active session pipelines, and flushes the serialized state queue before callers may remove its data directory. Store initialization and writes are serialized so concurrent sessions cannot race the initial state load or share a temporary state file.

Do not leak HaoCode PHP objects into the browser contract. Adapter-only response fields must use the `_fe_` prefix. Secrets stay in the local runtime-state file with mode `0600` and are never returned by API responses.
