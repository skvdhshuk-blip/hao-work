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
    public array $interruptOn;
    public string $hitlMode;
    public ?string $hitlReviewModel;
    public ?string $hitlAllowlistPath;

    public function __construct(mixed ...$options)
    {
        $this->maxTurns = $options['maxTurns'];
        $this->contextWindow = getenv('HAOCODE_CONTEXT_WINDOW') ?: null;
        $this->interruptOn = $options['interruptOn'] ?? [];
        $this->hitlMode = $options['hitlMode'] ?? 'ask';
        $this->hitlReviewModel = $options['hitlReviewModel'] ?? null;
        $this->hitlAllowlistPath = $options['hitlAllowlistPath'] ?? null;
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
    // SDK-native smart-HITL auto_decision fields.
    public ?string $interruptId = null;
    public ?string $actionId = null;
    public ?string $decision = null;
    public ?string $source = null;
    public ?string $riskLevel = null;
    public ?string $reason = null;

    public function __construct(
        public string $type,
        public ?string $text = null,
    ) {}
}

final class FakeActionRequest
{
    public function __construct(
        public string $id,
        public string $toolName,
        public array $input,
        public string $description = 'Review this action.',
        public array $allowedDecisions = ['approve', 'edit', 'reject'],
    ) {}

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'tool_name' => $this->toolName,
            'input' => $this->input,
            'description' => $this->description,
            'allowed_decisions' => $this->allowedDecisions,
            'agent_id' => null,
        ];
    }
}

final class FakeInterrupt
{
    public string $id = 'interrupt-1';
    public string $sessionId = 'session-1';
    public array $actions = [];

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'session_id' => $this->sessionId,
            'actions' => array_map(static fn (FakeActionRequest $action): array => $action->toArray(), $this->actions),
            'created_at' => '2025-01-01T00:00:00+00:00',
            'source_agent_id' => null,
            'source_team' => null,
        ];
    }
}

final class HaoCode
{
    private static function autoDecision(array $fields): Message
    {
        $message = new Message(type: 'auto_decision');
        foreach ($fields as $property => $value) {
            $message->{$property} = $value;
        }
        return $message;
    }

    public static function stream(string $prompt, HaoCodeConfig $config): \\Generator
    {
        if ($prompt === 'report interrupt on') {
            yield new Message(type: 'result', text: json_encode(array_keys($config->interruptOn)));
            return;
        }
        if ($prompt === 'report hitl config') {
            yield new Message(type: 'result', text: json_encode([
                'hitlMode' => $config->hitlMode,
                'hitlReviewModel' => $config->hitlReviewModel,
            ]));
            return;
        }
        if ($prompt === 'report hitl allowlist') {
            yield new Message(type: 'result', text: json_encode([
                'hitlAllowlistPath' => $config->hitlAllowlistPath,
            ]));
            return;
        }
        if ($prompt === 'emit auto sandbox') {
            yield self::autoDecision([
                'sessionId' => 'session-1',
                'interruptId' => 'interrupt-1',
                'actionId' => 'action-3',
                'toolName' => 'Bash',
                'toolInput' => ['command' => 'make build'],
                'decision' => 'approve',
                'source' => 'sandbox',
                'riskLevel' => 'low',
                'reason' => 'sandbox:contained: Runs inside the configured sandbox.',
            ]);
            yield new Message(type: 'result', text: 'auto continued');
            return;
        }
        if ($prompt === 'emit auto approve') {
            yield self::autoDecision([
                'sessionId' => 'session-1',
                'interruptId' => 'interrupt-1',
                'actionId' => 'action-1',
                'toolName' => 'Bash',
                'toolInput' => ['command' => 'pwd'],
                'decision' => 'approve',
                'source' => 'rule',
                'riskLevel' => 'low',
                'reason' => 'rule:allow: Read-only command allowlist.',
            ]);
            yield new Message(type: 'result', text: 'auto continued');
            return;
        }
        if ($prompt === 'emit auto reject') {
            yield self::autoDecision([
                'sessionId' => 'session-1',
                'interruptId' => 'interrupt-1',
                'actionId' => 'action-2',
                'toolName' => 'Write',
                'toolInput' => ['file_path' => '/etc/hosts'],
                'decision' => 'reject',
                'source' => 'review',
                'riskLevel' => 'medium',
                'reason' => 'review:deny: Writes outside the workspace.',
            ]);
            yield new Message(type: 'result', text: 'auto continued');
            return;
        }
        if ($prompt === 'emit auto escalate') {
            // Escalation semantics: one escalate auto_decision per action, then
            // the interrupt itself arrives unchanged and terminates the run.
            yield self::autoDecision([
                'sessionId' => 'session-1',
                'interruptId' => 'interrupt-1',
                'actionId' => 'action-1',
                'toolName' => 'Bash',
                'toolInput' => ['command' => 'rm -rf /'],
                'decision' => 'escalate',
                'source' => 'rule',
                'riskLevel' => 'high',
                'reason' => "rule:red_line: Red-line command 'rm -rf /'.",
            ]);
            $interrupt = new FakeInterrupt();
            $interrupt->actions = [new FakeActionRequest('action-1', 'Bash', ['command' => 'rm -rf /'])];
            $message = new Message(type: 'interrupt');
            $message->interrupt = $interrupt;
            yield $message;
            return;
        }
        if ($prompt === 'emit auto unknown') {
            yield self::autoDecision([
                'sessionId' => 'session-1',
                'interruptId' => 'interrupt-1',
                'actionId' => 'action-9',
                'toolName' => 'Bash',
                'toolInput' => ['command' => 'mystery'],
                'decision' => 'yolo',
                'source' => 'mystery',
                'riskLevel' => 'weird',
                'reason' => null,
            ]);
            yield new Message(type: 'result', text: 'auto continued');
            return;
        }
        if ($prompt === 'trigger interrupt') {
            $interrupt = new FakeInterrupt();
            $interrupt->actions = [new FakeActionRequest('action-1', 'Bash', ['command' => 'pwd'])];
            $message = new Message(type: 'interrupt');
            $message->interrupt = $interrupt;
            yield $message;
            return;
        }
        $maxTurns = $config->maxTurns === PHP_INT_MAX ? 'unlimited' : (string) $config->maxTurns;
        yield new Message(type: 'result', text: $prompt === 'report context window' ? $config->contextWindow : $maxTurns);
    }

    public static function streamResumeInterrupt(string $sessionId, string $interruptId, array $decisions, HaoCodeConfig $config): \\Generator
    {
        yield new Message(type: 'result', text: json_encode([
            'sessionId' => $sessionId,
            'interruptId' => $interruptId,
            'decisions' => $decisions,
        ]));
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

const runWorker = async ({ maxTurns, environmentMaxTurns, contextWindow, hitlMode, hitlReviewModel, hitlAllowlistPath, prompt } = {}) => {
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
    prompt: prompt ?? (contextWindow === undefined ? 'report max turns' : 'report context window'),
    cwd: temporaryDirectory,
    provider: contextWindow === undefined ? {} : { contextWindow },
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(hitlMode === undefined ? {} : { hitlMode }),
    ...(hitlReviewModel === undefined ? {} : { hitlReviewModel }),
    ...(hitlAllowlistPath === undefined ? {} : { hitlAllowlistPath }),
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

test('normalizes hitlMode and maps auto to an empty interruptOn', async () => {
  const auto = await runWorker({ prompt: 'report interrupt on', hitlMode: 'auto' });
  assert.deepEqual(JSON.parse(auto.at(-1)?.text), []);

  const smart = await runWorker({ prompt: 'report interrupt on', hitlMode: 'smart' });
  assert.deepEqual(JSON.parse(smart.at(-1)?.text), ['Bash', 'Write', 'Edit', 'apply_patch']);

  const invalid = await runWorker({ prompt: 'report interrupt on', hitlMode: 'yolo' });
  assert.deepEqual(JSON.parse(invalid.at(-1)?.text), ['Bash', 'Write', 'Edit', 'apply_patch']);

  const missing = await runWorker({ prompt: 'report interrupt on' });
  assert.deepEqual(JSON.parse(missing.at(-1)?.text), ['Bash', 'Write', 'Edit', 'apply_patch']);
});

test('passes hitlMode and hitlReviewModel through to the SDK config', async () => {
  const smart = await runWorker({ prompt: 'report hitl config', hitlMode: 'smart', hitlReviewModel: 'deepseek-chat' });
  assert.deepEqual(JSON.parse(smart.at(-1)?.text), { hitlMode: 'smart', hitlReviewModel: 'deepseek-chat' });

  const invalid = await runWorker({ prompt: 'report hitl config', hitlMode: 'yolo' });
  assert.deepEqual(JSON.parse(invalid.at(-1)?.text), { hitlMode: 'smart', hitlReviewModel: null });

  const missing = await runWorker({ prompt: 'report hitl config' });
  assert.deepEqual(JSON.parse(missing.at(-1)?.text), { hitlMode: 'smart', hitlReviewModel: null });
});

test('passes hitlAllowlistPath through to the SDK config', async () => {
  const configured = await runWorker({ prompt: 'report hitl allowlist', hitlAllowlistPath: '/tmp/hitl-allowlist.json' });
  assert.deepEqual(JSON.parse(configured.at(-1)?.text), { hitlAllowlistPath: '/tmp/hitl-allowlist.json' });

  const blank = await runWorker({ prompt: 'report hitl allowlist', hitlAllowlistPath: '   ' });
  assert.deepEqual(JSON.parse(blank.at(-1)?.text), { hitlAllowlistPath: null });

  const missing = await runWorker({ prompt: 'report hitl allowlist' });
  assert.deepEqual(JSON.parse(missing.at(-1)?.text), { hitlAllowlistPath: null });
});

test('forwards an SDK auto_decision sandbox event unchanged', async () => {
  const messages = await runWorker({ prompt: 'emit auto sandbox', hitlMode: 'smart' });
  assert.equal(messages.length, 2);

  const [decision, result] = messages;
  assert.deepEqual(decision, {
    type: 'auto_decision',
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    actionId: 'action-3',
    toolName: 'Bash',
    toolInput: { command: 'make build' },
    decision: 'approve',
    source: 'sandbox',
    riskLevel: 'low',
    reason: 'sandbox:contained: Runs inside the configured sandbox.',
  });

  assert.equal(result.type, 'result');
  assert.equal(result.text, 'auto continued');
});

test('forwards an SDK auto_decision approve event unchanged', async () => {
  const messages = await runWorker({ prompt: 'emit auto approve', hitlMode: 'smart' });
  assert.equal(messages.length, 2);

  const [decision, result] = messages;
  assert.deepEqual(decision, {
    type: 'auto_decision',
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    actionId: 'action-1',
    toolName: 'Bash',
    toolInput: { command: 'pwd' },
    decision: 'approve',
    source: 'rule',
    riskLevel: 'low',
    reason: 'rule:allow: Read-only command allowlist.',
  });

  assert.equal(result.type, 'result');
  assert.equal(result.text, 'auto continued');
});

test('forwards an SDK auto_decision reject event unchanged', async () => {
  const messages = await runWorker({ prompt: 'emit auto reject', hitlMode: 'smart' });
  assert.equal(messages.length, 2);

  const [decision, result] = messages;
  assert.deepEqual(decision, {
    type: 'auto_decision',
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    actionId: 'action-2',
    toolName: 'Write',
    toolInput: { file_path: '/etc/hosts' },
    decision: 'reject',
    source: 'review',
    riskLevel: 'medium',
    reason: 'review:deny: Writes outside the workspace.',
  });

  assert.equal(result.type, 'result');
});

test('forwards an escalate auto_decision followed by the unchanged interrupt', async () => {
  const messages = await runWorker({ prompt: 'emit auto escalate', hitlMode: 'smart' });
  assert.equal(messages.length, 2);

  const [escalation, interrupt] = messages;
  assert.deepEqual(escalation, {
    type: 'auto_decision',
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    actionId: 'action-1',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf /' },
    decision: 'escalate',
    source: 'rule',
    riskLevel: 'high',
    reason: "rule:red_line: Red-line command 'rm -rf /'.",
  });

  assert.equal(interrupt.type, 'interrupt');
  assert.equal(interrupt.interrupt.id, 'interrupt-1');
  assert.equal(interrupt.interrupt.actions.length, 1);
});

test('normalizes unknown auto_decision enum values conservatively', async () => {
  const messages = await runWorker({ prompt: 'emit auto unknown', hitlMode: 'smart' });
  assert.equal(messages.length, 2);

  const [decision, result] = messages;
  assert.equal(decision.type, 'auto_decision');
  assert.equal(decision.decision, 'reject');
  assert.equal(decision.source, 'rule');
  assert.equal(decision.riskLevel, 'high');
  assert.equal(decision.reason, '');
  assert.equal(decision.actionId, 'action-9');

  assert.equal(result.type, 'result');
});

test('ask mode still emits interrupts without auto decisions', async () => {
  const messages = await runWorker({ prompt: 'trigger interrupt', hitlMode: 'ask' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'interrupt');
  assert.equal(messages[0].interrupt.id, 'interrupt-1');
});
