import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHaoCodeStore } from './store.js';

const temporaryRoots = [];

const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-store-test-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  while (temporaryRoots.length) {
    await fs.rm(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

test('failed mutation rolls back and does not poison the queue', async () => {
  const root = await makeRoot();
  const store = createHaoCodeStore({ rootDir: root, logger: { warn() {}, error() {} } });

  await expect(store.mutate((state) => {
    state.sessions.push({ id: 'half-written' });
    throw new Error('boom');
  })).rejects.toThrow('boom');

  expect(await store.listSessions()).toEqual([]);

  await store.mutate((state) => {
    state.sessions.push({ id: 'durable', time: { updated: 1 } });
  });

  expect((await store.listSessions()).map((item) => item.id)).toEqual(['durable']);
  const persisted = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  expect(persisted.sessions.map((item) => item.id)).toEqual(['durable']);
});

test('serialization failures leave the committed snapshot intact', async () => {
  const root = await makeRoot();
  const store = createHaoCodeStore({ rootDir: root, logger: { warn() {}, error() {} } });
  await store.mutate((state) => {
    state.config.stable = true;
  });

  await expect(store.mutate((state) => {
    state.config.unserializable = 1n;
  })).rejects.toThrow();

  expect(await store.getConfig()).toEqual({ stable: true });
  await store.mutate((state) => {
    state.config.recovered = true;
  });
  expect(await store.getConfig()).toEqual({ stable: true, recovered: true });
});

test('corrupt JSON is quarantined and replaced on the next mutation', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'runtime-state.json'), '{not-json');
  const warnings = [];
  const store = createHaoCodeStore({
    rootDir: root,
    logger: { warn: (value) => warnings.push(value), error() {} },
  });

  expect(await store.listSessions()).toEqual([]);
  const names = await fs.readdir(root);
  expect(names.some((name) => name.startsWith('runtime-state.json.corrupt-'))).toBe(true);
  expect(warnings.some((line) => line.includes('Quarantined unreadable runtime state'))).toBe(true);

  await store.mutate((state) => {
    state.config.ready = true;
  });
  expect((await store.getConfig()).ready).toBe(true);
  expect(JSON.parse(await fs.readFile(store.statePath, 'utf8')).config.ready).toBe(true);
});

test('unsupported future state versions fail without rewriting the file', async () => {
  const root = await makeRoot();
  const statePath = path.join(root, 'runtime-state.json');
  const original = '{"version":2,"sessions":[{"id":"future"}]}\n';
  await fs.writeFile(statePath, original);
  const store = createHaoCodeStore({ rootDir: root, logger: { warn() {}, error() {} } });

  await expect(store.listSessions()).rejects.toThrow('Unsupported Hao Work runtime state version: 2');
  expect(await fs.readFile(statePath, 'utf8')).toBe(original);
});

test('preserves unknown version-one fields across later mutations', async () => {
  const root = await makeRoot();
  const statePath = path.join(root, 'runtime-state.json');
  await fs.writeFile(statePath, JSON.stringify({
    version: 1,
    sessions: [],
    futureMetadata: { keep: true },
  }));
  const store = createHaoCodeStore({ rootDir: root, logger: { warn() {}, error() {} } });

  await store.mutate((state) => {
    state.config.ready = true;
  });

  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  expect(persisted.futureMetadata).toEqual({ keep: true });
  expect(persisted.config.ready).toBe(true);
});

test('invalid top-level collection shapes are normalized defensively', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'runtime-state.json'), JSON.stringify({
    version: 1,
    sessions: {},
    messages: [],
    statuses: null,
    permissions: {},
    questions: 'bad',
    todos: [],
    interrupts: [],
    autoDecisions: [],
    providers: [],
    customProviders: [],
    config: [],
  }));
  const store = createHaoCodeStore({ rootDir: root, logger: { warn() {}, error() {} } });

  expect(await store.listSessions()).toEqual([]);
  expect(await store.getMessages('missing')).toEqual([]);
  expect(await store.getStatus()).toEqual({});
  expect(await store.getPermissions()).toEqual([]);
  expect(await store.getQuestions()).toEqual([]);
  expect(await store.getConfig()).toEqual({});
});

test('recovery continues even when the logger throws', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'runtime-state.json'), '{bad json', 'utf8');
  const store = createHaoCodeStore({
    rootDir: root,
    logger: { warn: () => { throw new Error('logger unavailable'); } },
  });

  expect(await store.getMessages('missing')).toEqual([]);
  await store.mutate((state) => { state.config.recovered = true; });
  expect((await store.getConfig()).recovered).toBe(true);
});

test('failed initial loads can be retried after the state file is repaired', async () => {
  const root = await makeRoot();
  const statePath = path.join(root, 'runtime-state.json');
  await fs.writeFile(statePath, JSON.stringify({ version: 2, config: { blocked: true } }), 'utf8');
  const store = createHaoCodeStore({ rootDir: root, logger: { warn: () => {} } });

  await expect(store.getConfig()).rejects.toMatchObject({ code: 'HAOWORK_STATE_UNSUPPORTED_VERSION' });
  await fs.writeFile(statePath, JSON.stringify({ version: 1, config: { repaired: true } }), 'utf8');
  expect(await store.getConfig()).toEqual({ repaired: true });
});
