import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { describe, expect, it } from 'vitest';

import { checkOpenCodeCLI } from '../cli.js';
import { createServeCommand } from './commands-serve.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = overrides[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function writeExecutable(filePath, content = '#!/bin/sh\nexit 0\n') {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

const FAKE_SERVER_SOURCE = `import fs from 'node:fs';
const port = Number(process.env.OPENCHAMBER_PORT || '0');
if (process.env.FAKE_SERVER_ENV_DUMP) {
  fs.writeFileSync(process.env.FAKE_SERVER_ENV_DUMP, JSON.stringify({
    opencodeBinary: process.env.OPENCODE_BINARY ?? null,
  }));
}
process.send({ type: 'openchamber:ready', port });
setInterval(() => {}, 1000);
`;

describe('checkOpenCodeCLI', () => {
  it('warns with OPENCODE_CLI_MISSING and returns null instead of throwing when no CLI is available', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const emptyBin = path.join(dir, 'empty-bin');
      fs.mkdirSync(emptyBin);
      await withEnv({ PATH: emptyBin, OPENCODE_BINARY: undefined }, async () => {
        const notices = [];
        const result = await checkOpenCodeCLI((notice) => notices.push(notice));

        expect(result).toBeNull();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toEqual(expect.objectContaining({
          level: 'warning',
          code: 'OPENCODE_CLI_MISSING',
        }));
        expect(notices[0].message).toContain('hao-code');
        expect(notices[0].message).toContain('settings.opencodeBinary');
        expect(process.env.OPENCODE_BINARY).toBeUndefined();
      });
    });
  });

  it('falls back from an invalid OPENCODE_BINARY override to a soft warning and drops the invalid value', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const emptyBin = path.join(dir, 'empty-bin');
      fs.mkdirSync(emptyBin);
      const invalidBinary = path.join(dir, 'not-a-real-opencode');
      await withEnv({ PATH: emptyBin, OPENCODE_BINARY: invalidBinary }, async () => {
        const notices = [];
        const result = await checkOpenCodeCLI((notice) => notices.push(notice));

        expect(result).toBeNull();
        expect(notices.map((notice) => notice.code)).toEqual([
          'OPENCODE_BINARY_INVALID',
          'OPENCODE_CLI_MISSING',
        ]);
        expect(process.env.OPENCODE_BINARY).toBeUndefined();
      });
    });
  });

  it('resolves opencode from PATH and preserves the existing found behavior', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const binDir = path.join(dir, 'bin');
      fs.mkdirSync(binDir);
      const fakeOpencode = path.join(binDir, 'opencode');
      writeExecutable(fakeOpencode);
      await withEnv({ PATH: binDir, OPENCODE_BINARY: undefined }, async () => {
        const notices = [];
        const result = await checkOpenCodeCLI((notice) => notices.push(notice));

        expect(result).toBe(fakeOpencode);
        expect(process.env.OPENCODE_BINARY).toBe(fakeOpencode);
        expect(notices).toEqual([]);
      });
    });
  });

  it('honors a valid OPENCODE_BINARY override without warnings', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const explicitBinary = path.join(dir, 'opencode-custom');
      writeExecutable(explicitBinary);
      await withEnv({ PATH: path.join(dir, 'empty-bin'), OPENCODE_BINARY: explicitBinary }, async () => {
        const notices = [];
        const result = await checkOpenCodeCLI((notice) => notices.push(notice));

        expect(result).toBe(explicitBinary);
        expect(process.env.OPENCODE_BINARY).toBe(explicitBinary);
        expect(notices).toEqual([]);
      });
    });
  });
});

describe('serve command without opencode CLI', () => {
  it('continues daemon startup with a soft OPENCODE_CLI_MISSING warning and no OPENCODE_BINARY in the child env', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const emptyBin = path.join(dir, 'empty-bin');
      fs.mkdirSync(emptyBin);
      const serverPath = path.join(dir, 'fake-server.mjs');
      const dumpPath = path.join(dir, 'env-dump.json');
      fs.writeFileSync(serverPath, FAKE_SERVER_SOURCE);

      await withEnv({ PATH: emptyBin, OPENCODE_BINARY: undefined, FAKE_SERVER_ENV_DUMP: dumpPath }, async () => {
        const port = await allocateLoopbackPort();
        const serveCommand = createServeCommand({
          serverPath,
          bunBin: process.execPath,
          checkOpenCodeCLI,
          getPreferredServerRuntime: () => 'node',
          setForegroundServerActive: () => {},
          setForegroundShutdown: () => {},
        });

        let childPid = null;
        try {
          const output = await captureStdout(async () => {
            await serveCommand({
              explicitPort: true,
              port,
              host: '127.0.0.1',
              json: true,
              suppressUnsafePortWarning: true,
            });
          });

          const payload = JSON.parse(output);
          childPid = payload.pid;
          expect(payload.port).toBe(port);
          expect(payload.messages.map((entry) => entry.code)).toContain('OPENCODE_CLI_MISSING');

          const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
          expect(dump.opencodeBinary).toBeNull();
        } finally {
          if (Number.isFinite(childPid)) {
            try {
              process.kill(childPid, 'SIGKILL');
            } catch {
            }
          }
        }
      });
    });
  });
});
