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

Same-origin session-chat iframes complete an authenticated parent-frame handshake before creating their SDK client. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own transport and rebinds its SDK before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

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
| `startup-url-selection.mjs` | Pure bundled/HMR startup probe and loopback connection-limit policy |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

From the repository root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/main.mjs`.

The Electron workspace package trusts Electron's install script so `bun install` downloads the platform runtime in fresh checkouts and worktrees.

Useful variants:

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

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:haocode-runtime` to install production Composer dependencies and stage the matching PHP/HaoCode runtime.
3. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
4. `rebuild:native` to rebuild native modules for Electron.
5. `package.mjs` to run `electron-builder`; its `afterPack` hook stages the rebuilt `better-sqlite3` binary that Electron Builder's Bun dependency collector otherwise omits.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

## Platform Notes

macOS packaging needs Xcode/build tools for notarized builds and icon asset compilation.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer. Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux AppImages must be built natively. Set `OPENCHAMBER_TARGET_ARCH=x64` or `OPENCHAMBER_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `hao-work`, desktop file `hao-work.desktop`, icon `hao-work`, and `StartupWMClass=hao-work`. The autostart helper reads and removes the legacy `openchamber.desktop` entry during migration.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

### Updater End-to-End Fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart; while disabled, Desktop does not create the native tray controller or start the renderer subscriptions, polling, quota refresh, or IPC updates that feed it.

## Bundled OpenCode CLI

Packaged Desktop builds include the official OpenCode CLI that matches the pinned `@opencode-ai/sdk` version in the root `package.json`. `prepare:opencode-cli` downloads the platform-specific release artifact, caches it under `packages/electron/.cache/opencode-cli`, stages `opencode` or `opencode.exe` into `resources/opencode-cli`, and verifies `opencode --version` before packaging. Re-running the step is fast when the staged binary already matches the pinned version.

Managed local Desktop startup prefers OpenCode binaries in this order:

1. `settings.opencodeBinary`.
2. Environment overrides: `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, or `OPENCHAMBER_OPENCODE_BIN`.
3. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
4. System installs discovered from PATH.
5. Known npm/Bun/Homebrew/Scoop/Chocolatey and other standard install locations.
6. Platform discovery through `where opencode` on Windows or a login shell on macOS/Linux.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_SKIP_LOCAL_SERVER=1` | Skips the in-process local OpenChamber server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_OPENCODE_CLI_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to the pinned root `@opencode-ai/sdk` version |
| `OPENCHAMBER_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCHAMBER_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- Tunnel lifecycle integration through the web server runtime.
- Auto-update checks, downloads, and restart/apply flow.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `Hao Work` app name.

Development builds use a separate user data directory named `Hao Work Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@openchamber/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup.
- Rebuild native modules after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

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
