import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createImageConversionWorker, resolveImageConverterWorkerPath } from './image-conversion-worker.js';

const FAKE_WORKER_SOURCE = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (String(message.dataUri).includes('crash')) process.exit(1);
    if (String(message.dataUri).includes('fail')) {
      process.stdout.write(JSON.stringify({ id: message.id, ok: false, error: 'conversion broke' }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ id: message.id, ok: true, text: 'done:' + message.kind }) + '\\n');
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
`;

const temporaryDirectories = [];
const workers = [];

afterEach(async () => {
  while (workers.length) workers.pop().dispose();
  while (temporaryDirectories.length) await fs.rm(temporaryDirectories.pop(), { recursive: true, force: true });
});

const createWorker = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-image-worker-'));
  temporaryDirectories.push(dir);
  const workerPath = path.join(dir, 'fake-worker.mjs');
  await fs.writeFile(workerPath, FAKE_WORKER_SOURCE);
  const worker = createImageConversionWorker({ dataDir: dir, logger: { log() {}, warn() {} }, workerPath });
  workers.push(worker);
  return worker;
};

describe('image conversion worker client', () => {
  test('resolves conversions over the stdio protocol', async () => {
    const worker = await createWorker();
    await expect(worker.ocr('data:image/png;base64,AAAA')).resolves.toBe('done:ocr');
    await expect(worker.caption('data:image/png;base64,AAAA')).resolves.toBe('done:caption');
  });

  test('surfaces converter errors without killing the worker', async () => {
    const worker = await createWorker();
    await expect(worker.ocr('data:fail')).rejects.toThrow('conversion broke');
    await expect(worker.caption('data:image/png;base64,AAAA')).resolves.toBe('done:caption');
  });

  test('a crashed worker rejects the in-flight request and respawns on the next call', async () => {
    const worker = await createWorker();
    await expect(worker.ocr('data:image/png;base64,AAAA')).resolves.toBe('done:ocr');
    await expect(worker.caption('crash')).rejects.toThrow(/worker exited/);
    // The next call spawns a fresh worker and succeeds.
    await expect(worker.ocr('data:image/png;base64,AAAA')).resolves.toBe('done:ocr');
  });

  test('worker path prefers app.asar.unpacked when it exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-worker-path-'));
    temporaryDirectories.push(dir);
    const asarDir = path.join(dir, 'app.asar', 'lib');
    const unpackedDir = path.join(dir, 'app.asar.unpacked', 'lib');
    await fs.mkdir(asarDir, { recursive: true });
    await fs.mkdir(unpackedDir, { recursive: true });
    await fs.writeFile(path.join(unpackedDir, 'image-converter-worker.mjs'), '// worker\n');
    expect(resolveImageConverterWorkerPath(asarDir)).toBe(path.join(unpackedDir, 'image-converter-worker.mjs'));
    expect(resolveImageConverterWorkerPath(path.join(dir, 'plain', 'lib'))).toBe(path.join(dir, 'plain', 'lib', 'image-converter-worker.mjs'));
  });
});
