import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const appendChunk = (state, chunk, onLine) => {
  state.buffer += chunk.toString('utf8');
  while (true) {
    const lineEnd = state.buffer.indexOf('\n');
    if (lineEnd < 0) return;
    const line = state.buffer.slice(0, lineEnd).trim();
    state.buffer = state.buffer.slice(lineEnd + 1);
    if (line) onLine(line);
  }
};

export const createWorkerSupervisor = ({
  phpBinary = process.env.HAOWORK_PHP_BINARY || 'php',
  workerPath = path.resolve(__dirname, '../../../../haocode-bridge/worker.php'),
  autoloadPath = process.env.HAOWORK_HAOCODE_AUTOLOAD || '',
} = {}) => {
  const active = new Map();

  const run = ({ sessionId, request, onEvent }) => new Promise((resolve, reject) => {
    if (active.has(sessionId)) {
      reject(new Error(`Session ${sessionId} is already running.`));
      return;
    }

    const child = spawn(phpBinary, [workerPath], {
      cwd: request.cwd,
      env: {
        ...process.env,
        ...(autoloadPath ? { HAOWORK_HAOCODE_AUTOLOAD: autoloadPath } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = { buffer: '' };
    let stderr = '';
    let settled = false;
    let resolveExit;
    const record = {
      child,
      exited: false,
      forceTimer: null,
      exitPromise: new Promise((done) => { resolveExit = done; }),
    };

    active.set(sessionId, record);

    const markExited = () => {
      if (record.exited) return;
      record.exited = true;
      if (record.forceTimer) clearTimeout(record.forceTimer);
      active.delete(sessionId);
      resolveExit();
    };

    child.stdout.on('data', (chunk) => appendChunk(stdout, chunk, (line) => {
      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        onEvent({ type: 'error', error: `Malformed HaoCode worker event: ${error.message}`, _fe_raw: line.slice(0, 500) });
      }
    }));
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      markExited();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      markExited();
      if (stdout.buffer.trim()) {
        try {
          onEvent(JSON.parse(stdout.buffer.trim()));
        } catch {
          // A partial final line is reported through the exit error below.
        }
      }
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ code, signal });
        return;
      }
      reject(new Error(stderr.trim() || `HaoCode worker exited with ${signal || `code ${code}`}.`));
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });

  const abort = (sessionId) => {
    const record = active.get(sessionId);
    if (!record) return false;
    record.child.kill('SIGTERM');
    if (record.forceTimer) return true;
    record.forceTimer = setTimeout(() => {
      if (!record.exited) record.child.kill('SIGKILL');
    }, 1500);
    record.forceTimer.unref?.();
    return true;
  };

  const stopAll = async () => {
    const records = [...active.values()];
    for (const sessionId of active.keys()) abort(sessionId);
    await Promise.all(records.map((record) => record.exitPromise));
  };

  return {
    run,
    abort,
    stopAll,
    isRunning: (sessionId) => active.has(sessionId),
    activeCount: () => active.size,
    phpBinary,
    workerPath,
  };
};
