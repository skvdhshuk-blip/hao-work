import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: [],
  messages: {},
  statuses: {},
  permissions: [],
  questions: [],
  todos: {},
  interrupts: {},
  providers: {},
  config: {},
});

const cloneEmptyState = () => JSON.parse(JSON.stringify(EMPTY_STATE));

export const createId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;

export const projectIdForDirectory = (directory) => `project_${crypto.createHash('sha1').update(directory).digest('hex').slice(0, 16)}`;

export const createHaoCodeStore = ({ rootDir }) => {
  const statePath = path.join(rootDir, 'runtime-state.json');
  let state = cloneEmptyState();
  let loadPromise = null;
  let writeQueue = Promise.resolve();

  const ensureLoaded = () => {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const decoded = JSON.parse(await fs.readFile(statePath, 'utf8'));
          if (decoded && typeof decoded === 'object' && decoded.version === 1) {
            state = { ...cloneEmptyState(), ...decoded };
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      })();
    }
    return loadPromise;
  };

  const persist = async () => {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, statePath);
    } finally {
      try {
        await fs.rm(temporary, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  };

  const mutate = async (updater) => {
    await ensureLoaded();
    let output;
    writeQueue = writeQueue.then(async () => {
      output = await updater(state);
      await persist();
    });
    await writeQueue;
    return output;
  };

  const read = async (reader) => {
    await ensureLoaded();
    await writeQueue;
    return reader(state);
  };

  const flush = async () => {
    await ensureLoaded();
    await writeQueue;
  };

  return {
    rootDir,
    statePath,
    read,
    mutate,
    flush,
    listSessions: (directory) => read((current) => current.sessions
      .filter((session) => !directory || session.directory === directory)
      .sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))),
    getSession: (sessionId) => read((current) => current.sessions.find((session) => session.id === sessionId) ?? null),
    getMessages: (sessionId) => read((current) => current.messages[sessionId] ?? []),
    getStatus: () => read((current) => ({ ...current.statuses })),
    getPermissions: (directory) => read((current) => current.permissions.filter((request) => !directory || request.directory === directory)),
    getQuestions: (directory) => read((current) => current.questions.filter((request) => !directory || request.directory === directory)),
    getTodos: (sessionId) => read((current) => current.todos[sessionId] ?? []),
    getProviderSettings: (providerId) => read((current) => ({ ...(current.providers[providerId] ?? {}) })),
    getConfig: () => read((current) => ({ ...current.config })),
  };
};
