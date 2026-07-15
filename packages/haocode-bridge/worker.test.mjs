import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./worker.php', import.meta.url));

const fakeAutoload = `<?php

declare(strict_types=1);

namespace HaoCode\\Sdk;

final class HaoCodeConfig
{
    public int $maxTurns;
    public ?string $contextWindow;

    public function __construct(mixed ...$options)
    {
        $this->maxTurns = $options['maxTurns'];
        $this->contextWindow = getenv('HAOCODE_CONTEXT_WINDOW') ?: null;
    }
}

final class Message
{
    public ?string $toolName = null;
    public ?array $toolInput = null;
    public ?string $toolOutput = null;
    public ?bool $toolIsError = null;
    public ?int $turnNumber = null;
    public ?string $sessionId = null;
    public ?array $usage = null;
    public ?float $cost = null;
    public ?string $error = null;
    public mixed $interrupt = null;

    public function __construct(
        public string $type,
        public ?string $text = null,
    ) {}
}

final class HaoCode
{
    public static function stream(string $prompt, HaoCodeConfig $config): \\Generator
    {
        $maxTurns = $config->maxTurns === PHP_INT_MAX ? 'unlimited' : (string) $config->maxTurns;
        yield new Message(type: 'result', text: $prompt === 'report context window' ? $config->contextWindow : $maxTurns);
    }
}
`;

const executeWorker = (request, env) => new Promise((resolve, reject) => {
  const child = spawn('php', [workerPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr || `Worker exited with ${signal || `code ${code}`}.`));
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
});

const runWorker = async ({ maxTurns, environmentMaxTurns, contextWindow } = {}) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-work-worker-'));
  const autoloadPath = path.join(temporaryDirectory, 'autoload.php');
  await fs.writeFile(autoloadPath, fakeAutoload);

  const env = {
    ...process.env,
    HAOWORK_HAOCODE_AUTOLOAD: autoloadPath,
  };
  if (environmentMaxTurns === undefined) delete env.HAOWORK_HAOCODE_MAX_TURNS;
  else env.HAOWORK_HAOCODE_MAX_TURNS = String(environmentMaxTurns);

  const request = {
    action: 'run',
    prompt: contextWindow === undefined ? 'report max turns' : 'report context window',
    cwd: temporaryDirectory,
    provider: contextWindow === undefined ? {} : { contextWindow },
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };

  try {
    const stdout = await executeWorker(request, env);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

test('has no practical turn limit by default for long-running tasks', async () => {
  const messages = await runWorker();
  assert.equal(messages.at(-1)?.text, 'unlimited');
});

test('accepts a process-wide max-turn override', async () => {
  const messages = await runWorker({ environmentMaxTurns: 320 });
  assert.equal(messages.at(-1)?.text, '320');
});

test('prefers a valid request override and falls back from invalid values', async () => {
  const overridden = await runWorker({ maxTurns: 17, environmentMaxTurns: 320 });
  assert.equal(overridden.at(-1)?.text, '17');

  const invalidRequest = await runWorker({ maxTurns: 0, environmentMaxTurns: 320 });
  assert.equal(invalidRequest.at(-1)?.text, '320');

  const invalidEnvironment = await runWorker({ environmentMaxTurns: 'invalid' });
  assert.equal(invalidEnvironment.at(-1)?.text, 'unlimited');
});

test('applies the runtime model context window to HaoCode', async () => {
  const messages = await runWorker({ contextWindow: 1_000_000 });
  assert.equal(messages.at(-1)?.text, '1000000');
});
