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
