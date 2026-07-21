import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ABORT_GRACE_MS = 1500;

const appendChunk = (state, chunk, onLine, maxEventBytes) => {
  // StringDecoder retains an incomplete UTF-8 sequence between pipe chunks;
  // plain chunk.toString('utf8') can corrupt CJK/emoji when a code point is
  // split across child-process reads, making otherwise valid JSON unusable.
  state.buffer += state.decoder.write(chunk);
  while (true) {
    const lineEnd = state.buffer.indexOf('\n');
    if (lineEnd < 0) break;
    const rawLine = state.buffer.slice(0, lineEnd);
    state.buffer = state.buffer.slice(lineEnd + 1);
    if (Buffer.byteLength(rawLine, 'utf8') > maxEventBytes) {
      throw new Error(`HaoCode worker event exceeded ${maxEventBytes} bytes.`);
    }
    const line = rawLine.trim();
    if (line) onLine(line);
  }
  if (Buffer.byteLength(state.buffer, 'utf8') > maxEventBytes) {
    throw new Error(`HaoCode worker event exceeded ${maxEventBytes} bytes before a newline.`);
  }
};

export const createWorkerSupervisor = ({
  phpBinary = process.env.HAOWORK_PHP_BINARY || 'php',
  workerPath = path.resolve(__dirname, '../../../../haocode-bridge/worker.php'),
  autoloadPath = process.env.HAOWORK_HAOCODE_AUTOLOAD || '',
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
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
    const stdout = { buffer: '', decoder: new StringDecoder('utf8') };
    let stderr = '';
    let settled = false;
    let protocolError = null;
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

    const stopCorruptWorker = () => {
      if (record.exited) return;
      try { child.kill('SIGTERM'); } catch { /* process already gone */ }
      if (record.forceTimer) return;
      record.forceTimer = setTimeout(() => {
        if (!record.exited) {
          try { child.kill('SIGKILL'); } catch { /* process already gone */ }
        }
      }, abortGraceMs);
      record.forceTimer.unref?.();
    };

    const reportProtocolError = (error, rawLine = '') => {
      if (protocolError) return;
      protocolError = error instanceof Error ? error : new Error(String(error));
      try {
        onEvent({
          type: 'error',
          error: protocolError.message,
          ...(rawLine ? { _fe_raw: rawLine.slice(0, 500) } : {}),
        });
      } catch (callbackError) {
        protocolError = new Error(`HaoCode event handler failed while reporting a protocol error: ${callbackError.message}`, {
          cause: callbackError,
        });
      }
      stopCorruptWorker();
    };

    const deliverLine = (line) => {
      if (protocolError) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        reportProtocolError(new Error(`Malformed HaoCode worker event: ${error.message}`, { cause: error }), line);
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        reportProtocolError(new Error('HaoCode worker event must be a JSON object.'), line);
        return;
      }
      try {
        onEvent(message);
      } catch (error) {
        reportProtocolError(new Error(`HaoCode event handler failed: ${error.message}`, { cause: error }), line);
      }
    };

    child.stdout.on('data', (chunk) => {
      if (protocolError) return;
      try {
        appendChunk(stdout, chunk, deliverLine, maxEventBytes);
      } catch (error) {
        reportProtocolError(error, stdout.buffer);
      }
    });
    child.stdout.on('error', (error) => {
      reportProtocolError(new Error(`Unable to read HaoCode worker output: ${error.message}`, { cause: error }));
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      markExited();
      reject(error);
    });
    // `close` runs after stdout/stderr are drained; settling on `exit` can
    // race the final JSON line still buffered in the pipe.
    child.on('close', (code, signal) => {
      markExited();
      if (!protocolError) stdout.buffer += stdout.decoder.end();
      if (!protocolError && stdout.buffer.trim()) {
        const tail = stdout.buffer.trim();
        if (Buffer.byteLength(tail, 'utf8') > maxEventBytes) {
          reportProtocolError(new Error(`HaoCode worker event exceeded ${maxEventBytes} bytes.`), tail);
        } else {
          deliverLine(tail);
        }
      }
      if (settled) return;
      settled = true;
      if (protocolError) {
        reject(protocolError);
        return;
      }
      if (code === 0) {
        resolve({ code, signal });
        return;
      }
      reject(new Error(stderr.trim() || `HaoCode worker exited with ${signal || `code ${code}`}.`));
    });

    // Avoid an unhandled EPIPE when a worker exits before consuming the request;
    // the child exit/error handler above remains the source of the run failure.
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(`${JSON.stringify(request)}\n`);
    } catch (error) {
      reportProtocolError(new Error(`Unable to send the HaoCode worker request: ${error.message}`, { cause: error }));
    }
  });

  const abort = (sessionId) => {
    const record = active.get(sessionId);
    if (!record) return false;
    try { record.child.kill('SIGTERM'); } catch { /* process already gone */ }
    if (record.forceTimer) return true;
    record.forceTimer = setTimeout(() => {
      if (!record.exited) {
        try { record.child.kill('SIGKILL'); } catch { /* process already gone */ }
      }
    }, abortGraceMs);
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
