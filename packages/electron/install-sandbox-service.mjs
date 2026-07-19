// Windows-only helper that installs the tokimo sandbox SYSTEM service via UAC.
//
// The tokimo Hyper-V backend uses an unprivileged runner that talks to a named
// pipe owned by a SYSTEM service (haocode-sandbox-svc-windows-amd64.exe). That
// service must be installed once with administrator rights; afterwards the
// runner connects to it without elevation. Following the desktop-shell skill:
//
// - The elevated action runs inside a single `Start-Process -Verb RunAs` call,
//   so UAC prompts exactly once and only the System Properties dialog flashes.
// - The elevated payload itself is a hidden PowerShell (`-WindowStyle Hidden`)
//   so no second console window appears.
// - The payload is passed as an EncodedCommand (UTF-16LE base64) so quoting
//   inside the elevated shell cannot be broken by the outer shell.
// - We never touch `cmd.exe /c`, `taskkill`, or batch shims, and the helper
//   itself is a first-level spawn (no grandchildren that `windowsHide` cannot
//   reach).
//
// Returns { ok: true } on success, throws on any failure (caller surfaces the
// message via the IPC error channel). No-op on non-Windows platforms.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SERVICE_NAME = 'HaocodeSandboxSvc';
const SERVICE_DESCRIPTION = 'HaoCode tokimo sandbox Hyper-V backend';

export const isWindowsSandboxInstallSupported = () => process.platform === 'win32';

const buildElevatedPayload = (svcBinaryPath) => {
  // The elevated PowerShell session runs this. The binary path comes from the
  // staged runtime, so quote it for the inner shell and escape any embedded
  // backslashes inside the JSON-style single-quoted path argument. New-Service
  // is idempotent only by failing on duplicate; we -ErrorAction SilentlyContinue
  // and check afterwards so re-running after a prior install still returns ok.
  const quoted = `'${svcBinaryPath.replace(/'/g, "''")}'`;
  return [
    `$svc = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue`,
    `if (-not $svc) {`,
    `  New-Service -Name '${SERVICE_NAME}' -BinaryPathName ${quoted} -StartupType Automatic -Description '${SERVICE_DESCRIPTION}' | Out-Null`,
    `  $svc = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue`,
    `}`,
    `if ($svc) { Set-Service -Name '${SERVICE_NAME}' -Status Running -ErrorAction SilentlyContinue }`,
    `if ($svc) { exit 0 } else { exit 1 }`,
  ].join(';');
};

export const installWindowsSandboxService = async ({ svcBinaryPath } = {}) => {
  if (process.platform !== 'win32') {
    throw new Error('Tokimo sandbox service install is only available on Windows.');
  }
  if (typeof svcBinaryPath !== 'string' || !svcBinaryPath.trim()) {
    throw new Error('svcBinaryPath is required.');
  }
  const absolute = path.resolve(svcBinaryPath);

  const payload = buildElevatedPayload(absolute);
  const encoded = Buffer.from(payload, 'utf16le').toString('base64');

  // Outer PowerShell stays unprivileged + hidden; it only spawns the elevated
  // inner process via -Verb RunAs (which is what triggers the UAC prompt).
  // -Wait makes the outer spawn block until the elevated process exits.
  const elevatedArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command',
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encoded}')`,
  ];
  const result = spawnSync('powershell.exe', elevatedArgs, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000, // UAC dialog has no programmatic deadline; cap it.
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `Failed to install the Haocode sandbox service (exit ${result.status}). ${detail}`.trim(),
    );
  }
  return { ok: true };
};
