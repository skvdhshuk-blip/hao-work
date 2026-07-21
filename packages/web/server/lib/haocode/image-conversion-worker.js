// In-process client for image-converter-worker.mjs. The onnxruntime-backed
// converters (OCR + caption) segfault the host when they crash (observed in
// the packaged Electron main process), so they run in a forked child and a
// native crash only rejects the in-flight request — the next call respawns.
//
// Spawning: `child_process.fork` uses process.execPath, which inside
// Electron is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes it behave
// as plain Node (harmless under real Node/Bun in dev). A plain-Node child
// cannot read app.asar, so the worker AND its entire runtime dependency
// closure are asarUnpack'ed (see packages/electron/package.json).
//
// Path: prefer the unpacked copy when this module's own URL points into
// app.asar.

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spawnWorkerProcess = (workerPath, env) => fork(workerPath, [], {
  silent: true,
  env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
});

export const resolveImageConverterWorkerPath = (moduleDir) => {
  const direct = path.join(moduleDir, 'image-converter-worker.mjs');
  if (direct.includes('app.asar') && !direct.includes('app.asar.unpacked')) {
    const unpacked = direct.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return direct;
};

const defaultWorkerPath = () => resolveImageConverterWorkerPath(path.dirname(fileURLToPath(import.meta.url)));

export const createImageConversionWorker = ({
  dataDir,
  logger = console,
  forkImpl = null,
  workerPath = defaultWorkerPath(),
} = {}) => {
  let child = null;
  let nextId = 1;
  let stdoutBuffer = '';
  const pending = new Map();

  const teardown = (error) => {
    const current = child;
    child = null;
    if (current) {
      try { current.kill(); } catch { /* already dead */ }
    }
    for (const [, request] of pending) request.reject(error);
    pending.clear();
  };

  const ensureChild = () => {
    if (child) return child;
    stdoutBuffer = '';
    const env = {
      ...process.env,
      HAOWORK_IMAGE_DATA_DIR: dataDir ?? '',
    };
    const spawned = forkImpl
      ? forkImpl(workerPath, [], { silent: true, env })
      : spawnWorkerProcess(workerPath, env);
    child = spawned;
    spawned.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          logger.warn?.(`[image-converter] unparsable worker line: ${line.slice(0, 120)}`);
          continue;
        }
        if (message.ready) continue;
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.ok) request.resolve(typeof message.text === 'string' ? message.text : '');
        else request.reject(new Error(message.error || 'image conversion failed'));
      }
    });
    spawned.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.warn?.(`[image-converter] ${text}`);
    });
    spawned.on('exit', (code, signal) => {
      logger.warn?.(`[image-converter] worker exited code=${code} signal=${signal}`);
      teardown(new Error(`image converter worker exited (${signal || `code ${code}`})`));
    });
    spawned.on('error', (error) => {
      logger.warn?.(`[image-converter] worker spawn error: ${error.message}`);
      teardown(error);
    });
    return spawned;
  };

  const request = (kind, dataUri) => new Promise((resolve, reject) => {
    let spawned;
    try {
      spawned = ensureChild();
    } catch (error) {
      reject(error);
      return;
    }
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    try {
      spawned.stdin.write(`${JSON.stringify({ id, kind, dataUri })}\n`);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });

  return {
    ocr: (dataUri) => request('ocr', dataUri),
    caption: (dataUri) => request('caption', dataUri),
    dispose: () => teardown(new Error('image converter worker disposed')),
  };
};
