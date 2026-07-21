import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWorkerSupervisor } from './worker-supervisor.js';

const temporaryRoots = [];

const fixture = async (source) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-worker-test-'));
  temporaryRoots.push(root);
  const workerPath = path.join(root, 'worker.mjs');
  await fs.writeFile(workerPath, source);
  return { root, workerPath };
};

afterEach(async () => {
  while (temporaryRoots.length) {
    await fs.rm(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

const supervisorFor = (workerPath, options = {}) => createWorkerSupervisor({
  phpBinary: process.execPath,
  phpArgs: [],
  workerPath,
  abortGraceMs: 50,
  ...options,
});

test('accepts a valid final JSON event without a trailing newline', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'result', text: 'ok' }));
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  const result = await supervisor.run({
    sessionId: 'valid-tail',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  });

  expect(result.code).toBe(0);
  expect(events).toEqual([{ type: 'result', text: 'ok' }]);
  expect(supervisor.activeCount()).toBe(0);
});

test('preserves UTF-8 characters split across stdout chunks', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    const payload = Buffer.from(JSON.stringify({ type: 'text', text: '你好 👋' }) + '\\n');
    const marker = Buffer.from('你');
    const split = payload.indexOf(marker) + 1;
    process.stdout.write(payload.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(payload.subarray(split));
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  await supervisor.run({
    sessionId: 'split-utf8',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  });

  expect(events).toEqual([{ type: 'text', text: '你好 👋' }]);
});

test('rejects a malformed final event even when the worker exits zero', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('{"type":');
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'bad-tail',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  })).rejects.toThrow(/Malformed HaoCode worker event/);

  expect(events.at(-1)?.type).toBe('error');
  expect(events.at(-1)?.error).toMatch(/Malformed HaoCode worker event/);
  expect(supervisor.activeCount()).toBe(0);
});

test('rejects and terminates after a malformed newline-delimited event', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('{not-json}\\n');
    setInterval(() => {}, 1000);
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'bad-line',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  })).rejects.toThrow(/Malformed HaoCode worker event/);

  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('error');
  expect(supervisor.activeCount()).toBe(0);
});

test('rejects oversized unterminated events instead of buffering without limit', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('x'.repeat(1024));
    setInterval(() => {}, 1000);
  `);
  const supervisor = supervisorFor(workerPath, { maxEventBytes: 128 });

  await expect(supervisor.run({
    sessionId: 'oversized',
    request: { cwd: root },
    onEvent: () => {},
  })).rejects.toThrow(/exceeded 128 bytes/);

  expect(supervisor.activeCount()).toBe(0);
});

test('rejects JSON primitives as invalid protocol events', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('null\\n');
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'primitive-event',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  })).rejects.toThrow(/must be a JSON object/);

  expect(events.at(-1)?.type).toBe('error');
  expect(supervisor.activeCount()).toBe(0);
});

test('turns event-handler exceptions into run failures and cleans up the child', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'text', text: 'hello' }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'handler-error',
    request: { cwd: root },
    onEvent: () => { throw new Error('consumer exploded'); },
  })).rejects.toThrow(/event handler failed/);

  expect(supervisor.activeCount()).toBe(0);
});

test('stops delivering later events from the same chunk after a protocol failure', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('not-json\\n' + JSON.stringify({ type: 'text', text: 'must-not-leak' }) + '\\n');
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'bad-then-valid',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  })).rejects.toThrow(/Malformed HaoCode worker event/);

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('error');
});

test('skips PHP warning/notice lines instead of failing the run', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('Warning: Undefined array key "images" in worker.php on line 142\\n');
    process.stdout.write('PHP Notice: Something harmless\\n');
    process.stdout.write(JSON.stringify({ type: 'result', text: 'ok' }) + '\\n');
  `);
  const events = [];
  const supervisor = supervisorFor(workerPath);

  const result = await supervisor.run({
    sessionId: 'php-noise',
    request: { cwd: root },
    onEvent: (event) => events.push(event),
  });

  expect(result.code).toBe(0);
  expect(events).toEqual([{ type: 'result', text: 'ok' }]);
});

test('reports skipped PHP noise when the worker later fails', async () => {
  const { root, workerPath } = await fixture(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write('Deprecated: old thing\\n');
    process.exit(1);
  `);
  const supervisor = supervisorFor(workerPath);

  await expect(supervisor.run({
    sessionId: 'php-noise-fail',
    request: { cwd: root },
    onEvent: () => {},
  })).rejects.toThrow(/1 PHP warning\/notice line\(s\) skipped/);
});
