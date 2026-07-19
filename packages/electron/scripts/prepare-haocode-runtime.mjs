import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const bridgeRoot = path.join(workspaceRoot, 'packages', 'haocode-bridge');
const outputRoot = path.join(electronRoot, 'resources', 'haocode-runtime');
const cacheRoot = path.join(electronRoot, '.cache', 'php-runtime');
const phpBinRelease = '1.2.0';
const phpVersion = process.env.HAOWORK_PHP_VERSION || '8.4';
// Pinned to the Composer-locked SDK version so the staged sandbox runner
// matches the bridge's vendored PHP code. Bump together with composer.lock.
const sandboxReleaseTag = process.env.HAOWORK_SANDBOX_RELEASE_TAG || 'v1.14.0';
const sandboxReleaseBase = process.env.HAOWORK_SANDBOX_RELEASE_BASE
  || 'https://github.com/skvdhshuk-blip/hao-code/releases/download';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`.trim());
  }
  return result;
};

const target = resolveTargetArchitecture();
const platformDirectory = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
if (!platformDirectory || (process.platform === 'win32' && target.node !== 'x64')) {
  throw new Error(`Unsupported HaoCode PHP runtime target: ${process.platform}/${target.node}`);
}

const binaryName = process.platform === 'win32' ? 'php.exe' : 'php';
const relativeArchivePath = `bin/${platformDirectory}/${target.node}/php-${phpVersion}.zip`;
const archiveUrl = `https://raw.githubusercontent.com/NativePHP/php-bin/${phpBinRelease}/${relativeArchivePath}`;
const archivePath = path.join(cacheRoot, phpBinRelease, relativeArchivePath);

const gitBlobSha = (buffer) => createHash('sha1')
  .update(`blob ${buffer.length}\0`)
  .update(buffer)
  .digest('hex');

const expectedBlobSha = async () => {
  const response = await fetch(`https://api.github.com/repos/NativePHP/php-bin/contents/${relativeArchivePath}?ref=${phpBinRelease}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hao-work-runtime-builder' },
  });
  if (!response.ok) throw new Error(`Unable to verify PHP runtime metadata (${response.status}).`);
  const metadata = await response.json();
  if (typeof metadata?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.sha)) {
    throw new Error('GitHub returned invalid PHP runtime metadata.');
  }
  return metadata.sha;
};

const ensureArchive = async () => {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const expected = await expectedBlobSha();
  if (fs.existsSync(archivePath)) {
    const current = fs.readFileSync(archivePath);
    if (gitBlobSha(current) === expected) return;
    fs.rmSync(archivePath, { force: true });
  }
  const response = await fetch(archiveUrl);
  if (!response.ok) throw new Error(`Unable to download PHP runtime (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (gitBlobSha(buffer) !== expected) throw new Error('Downloaded PHP runtime failed integrity verification.');
  fs.writeFileSync(archivePath, buffer, { mode: 0o644 });
};

const extractPhp = () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hao-work-php-'));
  try {
    if (process.platform === 'win32') {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(temporary)} -Force`]);
    } else {
      run('unzip', ['-q', archivePath, '-d', temporary]);
    }
    const candidates = fs.readdirSync(temporary, { recursive: true })
      .map((entry) => path.join(temporary, entry.toString()))
      .filter((entry) => fs.statSync(entry).isFile() && path.basename(entry).toLowerCase() === binaryName.toLowerCase());
    if (candidates.length !== 1) throw new Error(`PHP archive contained ${candidates.length} matching executables.`);
    const destination = path.join(outputRoot, 'php', binaryName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(candidates[0], destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

const prepareBridge = () => {
  run('composer', ['install', '--no-dev', '--classmap-authoritative', '--no-interaction'], {
    cwd: bridgeRoot,
    stdio: 'inherit',
  });
  const destination = path.join(outputRoot, 'bridge');
  fs.cpSync(bridgeRoot, destination, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`),
  });
};

// Native tokimo sandbox runner assets for the current host. Mirrors the SDK's
// SandboxBinaryInstaller.platformBinaryName / platformAssetNames: macOS ships
// a single arm64 runner, Linux arm64 + amd64, Windows amd64 plus the Hyper-V
// SYSTEM service that the unprivileged runner connects to over a named pipe.
// Returns [] on platforms the SDK does not target so the build still succeeds
// (the server reports `supported: false` and the UI disables the toggle).
const sandboxAssets = () => {
  const arch = resolveTargetArchitecture().node;
  if (process.platform === 'darwin') return ['haocode-sandbox-darwin-arm64'];
  if (process.platform === 'linux') return [`haocode-sandbox-linux-${arch}`];
  if (process.platform === 'win32') {
    return ['haocode-sandbox-windows-amd64.exe', 'haocode-sandbox-svc-windows-amd64.exe'];
  }
  return [];
};

// The runner the worker spawns at session time (everything except the Windows
// service, which is installed by main.mjs on first enable). Goes into runtime.json
// so configurePackagedHaoCodeRuntime can wire HAOCODE_SANDBOX_BINARY.
const sandboxRunnerAsset = () => {
  const assets = sandboxAssets();
  if (process.platform === 'win32') return 'haocode-sandbox-windows-amd64.exe';
  return assets[0] ?? null;
};

const prepareSandboxRunner = async () => {
  const assets = sandboxAssets();
  if (assets.length === 0) return null;
  const destination = path.join(outputRoot, 'sandbox');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const asset of assets) {
    const expected = await (await fetch(`${sandboxReleaseBase}/${sandboxReleaseTag}/${asset}.sha256`)).text();
    const expectedSha = expected.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
      throw new Error(`Sandbox asset ${asset} has an invalid SHA256 sidecar.`);
    }
    const response = await fetch(`${sandboxReleaseBase}/${sandboxReleaseTag}/${asset}`);
    if (!response.ok) {
      throw new Error(`Unable to download sandbox asset ${asset} (${response.status}).`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const actualSha = createHash('sha256').update(buffer).digest('hex');
    if (actualSha !== expectedSha) {
      throw new Error(`Sandbox asset ${asset} failed SHA256 verification.`);
    }
    const dest = path.join(destination, asset);
    fs.writeFileSync(dest, buffer);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  }
  return sandboxRunnerAsset();
};

const main = async () => {
  if (!/^8\.[3-9]$/.test(phpVersion)) throw new Error(`Invalid HAOWORK_PHP_VERSION: ${phpVersion}`);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  await ensureArchive();
  extractPhp();
  prepareBridge();
  const stagedSandboxRunner = await prepareSandboxRunner();
  fs.writeFileSync(path.join(outputRoot, 'runtime.json'), `${JSON.stringify({
    php: `php/${binaryName}`,
    worker: 'bridge/worker.php',
    autoload: 'bridge/vendor/autoload.php',
    phpVersion,
    phpBinRelease,
    ...(stagedSandboxRunner ? { sandboxBinary: `sandbox/${stagedSandboxRunner}` } : {}),
  }, null, 2)}\n`);
  console.log(`[electron] prepared HaoCode runtime: ${outputRoot}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
