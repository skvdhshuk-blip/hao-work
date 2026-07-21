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
  autoDecisions: {},
  providers: {},
  customProviders: {},
  config: {},
});

const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const cloneEmptyState = () => cloneJson(EMPTY_STATE);
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeState = (decoded) => ({
  // Preserve unrecognized v1 fields so a newer build can add optional state
  // without an older compatible build silently deleting it on the next write.
  ...decoded,
  version: 1,
  sessions: Array.isArray(decoded.sessions) ? decoded.sessions : [],
  messages: isRecord(decoded.messages) ? decoded.messages : {},
  statuses: isRecord(decoded.statuses) ? decoded.statuses : {},
  permissions: Array.isArray(decoded.permissions) ? decoded.permissions : [],
  questions: Array.isArray(decoded.questions) ? decoded.questions : [],
  todos: isRecord(decoded.todos) ? decoded.todos : {},
  interrupts: isRecord(decoded.interrupts) ? decoded.interrupts : {},
  autoDecisions: isRecord(decoded.autoDecisions) ? decoded.autoDecisions : {},
  providers: isRecord(decoded.providers) ? decoded.providers : {},
  customProviders: isRecord(decoded.customProviders) ? decoded.customProviders : {},
  config: isRecord(decoded.config) ? decoded.config : {},
});

export const createId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;

export const projectIdForDirectory = (directory) => `project_${crypto.createHash('sha1').update(directory).digest('hex').slice(0, 16)}`;

export const createHaoCodeStore = ({ rootDir, logger = console }) => {
  const statePath = path.join(rootDir, 'runtime-state.json');
  let state = cloneEmptyState();
  let loadPromise = null;
  // This queue is deliberately kept fulfilled after each operation. The caller
  // that owns a failed mutation still receives the rejection, while later reads
  // and writes are not permanently poisoned by an earlier disk/updater error.
  let writeQueue = Promise.resolve();

  const warn = (message) => {
    try { logger.warn?.(message); } catch { /* logging must not break recovery */ }
  };

  const readStateFile = async () => {
    let contents;
    try {
      contents = await fs.readFile(statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return cloneEmptyState();
      throw error;
    }

    let decoded;
    try {
      decoded = JSON.parse(contents);
    } catch (error) {
      const corruption = new Error(`Unable to parse Hao Work runtime state: ${error.message}`, { cause: error });
      corruption.code = 'HAOWORK_STATE_CORRUPT';
      throw corruption;
    }

    if (!isRecord(decoded)) {
      const corruption = new Error('Hao Work runtime state must contain a JSON object.');
      corruption.code = 'HAOWORK_STATE_CORRUPT';
      throw corruption;
    }
    if (decoded.version !== 1) {
      const unsupported = new Error(`Unsupported Hao Work runtime state version: ${String(decoded.version)}.`);
      unsupported.code = 'HAOWORK_STATE_UNSUPPORTED_VERSION';
      throw unsupported;
    }
    return normalizeState(decoded);
  };

  const quarantineCorruptState = async (error) => {
    const backupPath = `${statePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await fs.rename(statePath, backupPath);
    warn(`[HaoCode store] Quarantined unreadable runtime state at ${backupPath}: ${error.message}`);
    return cloneEmptyState();
  };

  const loadState = async ({ recoverCorruption = false } = {}) => {
    try {
      return await readStateFile();
    } catch (error) {
      if (recoverCorruption && error?.code === 'HAOWORK_STATE_CORRUPT') {
        return quarantineCorruptState(error);
      }
      throw error;
    }
  };

  const ensureLoaded = () => {
    if (!loadPromise) {
      const pending = loadState({ recoverCorruption: true }).then((loaded) => {
        state = loaded;
      });
      loadPromise = pending.catch((error) => {
        // A transient read error or a manually repaired future-version file
        // should be retryable without recreating the whole server instance.
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  };

  const persist = async (nextState) => {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(nextState, null, 2);
    const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, `${serialized}\n`, { mode: 0o600 });
      await fs.rename(temporary, statePath);
    } finally {
      try {
        await fs.rm(temporary, { force: true });
      } catch (error) {
        // The atomic rename already determines commit success. A best-effort
        // cleanup failure must not turn a committed write into an in-memory
        // rollback or mask the original write error.
        if (error?.code !== 'ENOENT') warn(`[HaoCode store] Unable to remove temporary state file ${temporary}: ${error.message}`);
      }
    }
    // Keep the in-memory snapshot byte-for-byte representable by the durable
    // JSON format (for example, functions or undefined values are not retained
    // only in memory after a successful write).
    return JSON.parse(serialized);
  };

  const mutate = async (updater) => {
    await ensureLoaded();
    const operation = writeQueue.then(async () => {
      // Mutate an isolated draft and publish it only after the atomic file
      // replacement succeeds. Updater exceptions and serialization/disk errors
      // therefore leave both the in-memory state and later queued operations on
      // the last committed snapshot.
      const draft = cloneJson(state);
      const output = await updater(draft);
      state = await persist(draft);
      return output;
    });
    writeQueue = operation.catch(() => {});
    return operation;
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
    getAutoDecisions: (sessionId) => read((current) => current.autoDecisions[sessionId] ?? []),
    getProviderSettings: (providerId) => read((current) => ({ ...(current.providers[providerId] ?? {}) })),
    getConfig: () => read((current) => ({ ...current.config })),
  };
};
