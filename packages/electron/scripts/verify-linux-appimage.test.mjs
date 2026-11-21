import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LINUX_IDENTITY } from '../linux-identity.mjs';
import { linuxAppImageArchSuffix, readElfArchitecture, verifyExtractedPayload } from './verify-linux-appimage.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const writeIcon = (root, relativePath) => {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), 'icon');
  fs.rmSync(path.join(root, '.DirIcon'), { force: true });
  fs.symlinkSync(relativePath, path.join(root, '.DirIcon'));
};

const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-payload-test-'));
  fs.writeFileSync(path.join(root, LINUX_IDENTITY.desktopFileName), [
    '[Desktop Entry]', `Name=${LINUX_IDENTITY.productName}`, `Exec=AppRun --no-sandbox %U`, `Icon=${LINUX_IDENTITY.iconName}`, `StartupWMClass=${LINUX_IDENTITY.startupWMClass}`, '',
  ].join('\n'));
  writeElf(path.join(root, LINUX_IDENTITY.executableName), 'x64');
  const runtime = path.join(root, 'resources/haocode-runtime');
  const manifest = { php: 'php/php', worker: 'bridge/worker.php', autoload: 'bridge/vendor/autoload.php' };
  writeElf(path.join(runtime, manifest.php), 'x64');
  fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify(manifest));
  for (const asset of [manifest.worker, manifest.autoload,
    'resources/app.asar.unpacked/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx',
    'resources/app.asar.unpacked/node_modules/onnxruntime-node/package.json']) {
    const file = path.join(asset.startsWith('resources/') ? root : runtime, asset);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  writeElf(path.join(root, 'resources/ripgrep/rg'), 'x64');
  for (const name of ['pty.node', 'sherpa-onnx.node']) {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  writeIcon(root, 'usr/share/icons/hicolor/512x512/apps/hao-work.png');
  return root;
};

const verify = (root) => verifyExtractedPayload({
  root,
  targetArchitecture: 'x64',
});

test('reads supported ELF architectures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-elf-test-'));
  try {
    writeElf(path.join(root, 'x64'), 'x64');
    writeElf(path.join(root, 'arm64'), 'arm64');
    assert.equal(readElfArchitecture(path.join(root, 'x64')), 'x64');
    assert.equal(readElfArchitecture(path.join(root, 'arm64')), 'arm64');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AppImage artifact names use electron-builder arch suffixes', () => {
  assert.equal(linuxAppImageArchSuffix('x64'), 'x86_64');
  assert.equal(linuxAppImageArchSuffix('arm64'), 'arm64');
});

test('verifies the Hao Work identity and HaoCode runtime architecture', () => {
  const root = createPayload();
  try {
    const result = verify(root);
    assert.equal(result.nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'));
    assert.throws(() => verify(root), /Missing packaged native module: pty\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails when the OCR model asset stays inside the asar', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx'));
    assert.throws(() => verify(root), /Missing unpacked runtime asset: node_modules\/@gutenye\/ocr-models/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails when the PHP runtime or native modules have the wrong architecture', () => {
  const root = createPayload();
  try {
    const php = path.join(root, 'resources/haocode-runtime/php/php');
    writeElf(php, 'arm64');
    assert.throws(() => verify(root), /HaoCode PHP architecture mismatch/);
    writeElf(php, 'x64');
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'), 'arm64');
    assert.throws(() => verify(root), /Native module architecture mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a scalable theme icon', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'usr/share/icons/hicolor/512x512'), { recursive: true });
    writeIcon(root, 'usr/share/icons/hicolor/scalable/apps/hao-work.svg');
    assert.equal(verify(root).nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails when the theme cannot resolve Icon=hao-work', () => {
  for (const relativePath of [
    'usr/share/icons/hicolor/scalable/hao-work.svg',
    'usr/share/icons/hicolor/1024x1024/apps/hao-work.png',
  ]) {
    const root = createPayload();
    try {
      fs.rmSync(path.join(root, 'usr/share/icons/hicolor/512x512'), { recursive: true });
      writeIcon(root, relativePath);
      assert.throws(() => verify(root), /Missing theme icon/, relativePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('fails when .DirIcon is dangling', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, '.DirIcon'));
    fs.symlinkSync('usr/share/icons/hicolor/scalable/hao-work.svg', path.join(root, '.DirIcon'));
    assert.throws(() => verify(root), /\.DirIcon does not resolve/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
