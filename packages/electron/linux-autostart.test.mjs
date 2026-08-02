import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEGACY_LINUX_IDENTITY, LINUX_IDENTITY } from './linux-identity.mjs';
import {
  buildLinuxAutostartDesktopEntry,
  readLinuxAutostartEnabled,
  resolveLinuxAutostartFilePath,
  resolveLinuxLaunchExecutable,
  setLinuxAutostartEnabled,
} from './linux-autostart.mjs';

test('prefers APPIMAGE path for Linux autostart Exec', () => {
  assert.equal(
    resolveLinuxLaunchExecutable({
      env: { APPIMAGE: '/home/user/Hao Work.AppImage' },
      execPath: '/tmp/.mount_OpenChXXXX/openchamber',
    }),
    '/home/user/Hao Work.AppImage',
  );
});

test('builds a background autostart desktop entry', () => {
  const entry = buildLinuxAutostartDesktopEntry({
    executable: '/home/user/Open Chamber.AppImage',
    backgroundArg: '--background',
  });
  assert.match(entry, /Type=Application/);
  assert.match(entry, /Exec="\/home\/user\/Open Chamber\.AppImage" --background/);
  assert.match(entry, /Name=Hao Work/);
  assert.match(entry, new RegExp(`StartupWMClass=${LINUX_IDENTITY.startupWMClass}`));
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
});

test('writes and removes the XDG autostart file', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-autostart-'));
  const env = { XDG_CONFIG_HOME: path.join(homeDir, 'config') };
  const filePath = resolveLinuxAutostartFilePath({ env, homeDir });

  try {
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);

    const enabled = await setLinuxAutostartEnabled({
      enabled: true,
      backgroundArg: '--background',
      env: { ...env, APPIMAGE: '/opt/Hao Work.AppImage' },
      homeDir,
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.filePath, filePath);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);

    const contents = await fs.readFile(filePath, 'utf8');
    assert.match(contents, /Exec="\/opt\/Hao Work\.AppImage" --background/);
    assert.match(contents, new RegExp(`StartupWMClass=${LINUX_IDENTITY.startupWMClass}`));

    const disabled = await setLinuxAutostartEnabled({
      enabled: false,
      env,
      homeDir,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('migrates the legacy OpenChamber autostart entry', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-autostart-migration-'));
  const env = { XDG_CONFIG_HOME: path.join(homeDir, 'config') };
  const directory = path.join(env.XDG_CONFIG_HOME, 'autostart');
  const legacyPath = path.join(directory, LEGACY_LINUX_IDENTITY.desktopFileName);
  const currentPath = resolveLinuxAutostartFilePath({ env, homeDir });

  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(legacyPath, 'legacy', 'utf8');
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);

    await setLinuxAutostartEnabled({ enabled: true, backgroundArg: '--background', env, homeDir });
    await fs.access(currentPath);
    await assert.rejects(fs.access(legacyPath));

    await setLinuxAutostartEnabled({ enabled: false, env, homeDir });
    await assert.rejects(fs.access(currentPath));
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
