# Hao Work Desktop

Electron desktop runtime for Hao Work on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The shared React UI lives in `packages/ui`; the local API server and HaoCode compatibility runtime live in `packages/web`.

## Runtime architecture

Electron starts the web server in the main process. The server exposes the OpenCode-shaped API expected by the inherited OpenChamber UI, but executes local agent sessions through the bundled HaoCode PHP SDK.

Packaged builds include all required local runtime files under `resources/haocode-runtime`:

- a platform-specific PHP binary;
- the HaoCode bridge worker;
- Composer production dependencies, including `sk-wang/hao-code`;
- a runtime manifest used by Electron at startup.

Users do not need to install PHP, Composer, OpenCode, or Tokimo separately.

### Sandbox runtime

When a project opts into sandbox execution (see `packages/web/server/lib/haocode/DOCUMENTATION.md`), the HaoCode engine runs file, search, and shell tools inside a tokimo virtual machine. `prepare-haocode-runtime.mjs` stages the platform-matching tokimo runner under `resources/haocode-runtime/sandbox/` (plus the Hyper-V SYSTEM service on Windows), and `runtime.json` records its path as `sandboxBinary`. At startup `configurePackagedHaoCodeRuntime()` (in `main.mjs`) exports that path through the `HAOCODE_SANDBOX_BINARY` environment variable so the SDK's `SandboxBinaryResolver` finds it without any user setup.

The much larger guest kernel + rootfs is **not** staged here. The first time a project enables the sandbox, the OpenChamber server invokes the SDK's own installer (`vendor/bin/hao-code-sandbox install --with-runtime`) to download and verify those artifacts into the user cache. On Windows the Hyper-V SYSTEM service is installed on first enable through the `desktop_install_sandbox_service` IPC handler (main.mjs), which elevates once via UAC; afterwards the unprivileged runner connects to it over a named pipe.

macOS packaging adds the `com.apple.security.hypervisor` entitlement (see `resources/entitlements.mac.plist`) so the runner can use Apple Hypervisor.framework. The release and smoke workflows assert that entitlement is present.

## Main files

| File | Purpose |
|---|---|
| `main.mjs` | Electron lifecycle, windows, native IPC, updates, and local server startup |
| `preload.mjs` | Restricted renderer-to-Electron bridge |
| `scripts/build-web-assets.mjs` | Builds and stages the web UI |
| `scripts/prepare-haocode-runtime.mjs` | Installs production Composer dependencies and stages PHP plus the HaoCode worker |
| `scripts/generate-brand-icons.mjs` | Generates platform icon assets from the application SVG icon |
| `scripts/bundle-main.mjs` | Bundles the Electron main process |
| `scripts/rebuild-native.mjs` | Rebuilds native modules for Electron |
| `scripts/package.mjs` | Runs `electron-builder` |

## Development

From the repository root:

```bash
bun install
bun run electron:dev
```

Useful checks:

```bash
bun run type-check:electron
bun run --cwd packages/electron test:architecture
bun run electron:dev:bundled
```

The development launcher uses the repository bridge at `packages/haocode-bridge`. Override its runtime only when debugging:

| Variable | Purpose |
|---|---|
| `HAOWORK_PHP_BINARY` | PHP executable used by the HaoCode worker |
| `HAOWORK_HAOCODE_WORKER` | Bridge `worker.php` path |
| `HAOWORK_HAOCODE_AUTOLOAD` | Composer `vendor/autoload.php` path |

Provider credentials remain environment- or settings-based. Supported environment variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `DEEPSEEK_API_KEY`.

## Packaging

Build the native package from the repository root:

```bash
bun run electron:build
```

For a local unsigned macOS application directory:

```bash
bun run --cwd packages/electron package -- --mac --arm64 --dir
```

The packaging pipeline:

1. builds and stages web assets;
2. generates Hao Work icons;
3. installs production-only bridge dependencies and stages the matching PHP runtime;
4. bundles the Electron main process;
5. rebuilds native modules;
6. runs `electron-builder`.

Build output is written to `packages/electron/dist`. Runtime staging and build output are generated artifacts and are excluded from Git.

Signed public macOS releases still require Apple signing and notarization credentials. Local smoke-test builds may use ad-hoc signing.

## Compatibility boundary

Internal package names, preload identifiers, and some deep-link/runtime contracts retain the OpenChamber/OpenCode naming expected by the inherited UI. These are compatibility details, not an external OpenCode process dependency. New agent execution logic belongs in `packages/web/server/lib/haocode`; Electron should remain a thin native shell.

## Quick release checks

```bash
bun run type-check
bun run --cwd packages/web test
bun run --cwd packages/electron test:architecture
bun run --cwd packages/electron bundle:main
composer validate --working-dir=packages/haocode-bridge --strict
```
