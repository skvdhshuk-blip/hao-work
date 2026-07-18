import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createHaoCodeCompatibilityServer } from './compat-server.js';

const execFileAsync = promisify(execFile);

const runtimes = [];
const temporaryDirectories = [];

afterEach(async () => {
  while (runtimes.length) await runtimes.pop().stop();
  while (temporaryDirectories.length) await fs.rm(temporaryDirectories.pop(), { recursive: true, force: true });
});

const createRuntime = async ({
  modelsMetadataLoader = async () => ({
    metadata: {
      deepseek: {
        id: 'deepseek',
        models: {
          'deepseek-chat': { limit: { context: 1_000_000, output: 384_000 } },
        },
      },
    },
  }),
} = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hao-work-compat-'));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  const worker = path.join(root, 'fake-worker.mjs');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(root, 'composer.lock'), JSON.stringify({
    packages: [{ name: 'sk-wang/hao-code', version: 'v9.8.7' }],
  }));
  await fs.writeFile(worker, `
let body = '';
for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (request.action === 'resume_interrupt') {
  const decision = request.decisions?.[0] ?? {};
  const text = decision.type === 'reject' ? 'rejected' : decision.type === 'respond' ? 'answered' : 'continued';
  const echoed = request.interruptId === 'int_probe'
    ? JSON.stringify({ hitlAllowlistPath: request.hitlAllowlistPath ?? null })
    : text;
  emit({ type: 'text', text: echoed });
  emit({ type: 'result', text: echoed, sessionId: request.haocodeSessionId, usage: { input_tokens: 2, output_tokens: 1 }, cost: 0.001 });
} else if (request.prompt === 'interrupt') {
  emit({ type: 'interrupt', interrupt: { id: 'int_1', session_id: 'hao_1', actions: [{ id: 'act_1', tool_name: 'Bash', input: { command: 'pwd' }, description: 'Run pwd', allowed_decisions: ['approve', 'reject'] }], created_at: new Date().toISOString() } });
} else if (request.prompt === 'interrupt-probe') {
  emit({ type: 'interrupt', interrupt: { id: 'int_probe', session_id: 'hao_probe', actions: [{ id: 'act_probe', tool_name: 'Bash', input: { command: '  ls -la  ' }, description: 'Run ls', allowed_decisions: ['approve', 'reject'] }], created_at: new Date().toISOString() } });
} else if (request.prompt.startsWith('interrupt-cmd:')) {
  const command = request.prompt.slice('interrupt-cmd:'.length);
  emit({ type: 'interrupt', interrupt: { id: 'int_cmd', session_id: 'hao_cmd', actions: [{ id: 'act_cmd', tool_name: 'Bash', input: { command }, description: 'Run command', allowed_decisions: ['approve', 'reject'] }], created_at: new Date().toISOString() } });
} else if (request.prompt === 'question') {
  emit({ type: 'interrupt', interrupt: { id: 'int_question', session_id: 'hao_question', actions: [{ id: 'act_question', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes', description: 'Continue' }] }] }, description: 'Ask the user', allowed_decisions: ['respond'] }], created_at: new Date().toISOString() } });
} else if (request.prompt === 'multi-interrupt') {
  emit({ type: 'interrupt', interrupt: { id: 'int_2', session_id: 'hao_2', actions: [
    { id: 'act_1', tool_name: 'Bash', input: { command: 'pwd' }, description: 'Run pwd', allowed_decisions: ['approve', 'reject'] },
    { id: 'act_2', tool_name: 'Write', input: { file_path: 'result.txt' }, description: 'Write result', allowed_decisions: ['approve', 'reject'] }
  ], created_at: new Date().toISOString() } });
} else if (request.prompt === 'wait') {
  emit({ type: 'text', text: 'waiting' });
  setInterval(() => {}, 1000);
} else if (request.prompt === 'empty') {
  // Exit successfully without a terminal event to exercise empty-response handling.
} else if (request.prompt === 'crash') {
  process.stderr.write('fixture worker crash');
  process.exit(7);
} else if (request.prompt === 'session-a' || request.prompt === 'session-b') {
  await new Promise((resolve) => setTimeout(resolve, request.prompt === 'session-a' ? 80 : 20));
  emit({ type: 'text', text: request.prompt });
  emit({ type: 'result', text: request.prompt, sessionId: 'hao_' + request.prompt, usage: {}, cost: 0 });
} else if (request.prompt === 'limits') {
  const text = JSON.stringify({ context: request.provider.contextWindow, output: request.provider.maxTokens });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_limits', usage: {}, cost: 0 });
} else if (request.prompt === 'request-config') {
  const text = JSON.stringify({ appendSystemPrompt: request.appendSystemPrompt, mcpSettingsPath: request.mcpSettingsPath, allowedTools: request.allowedTools, hitlAllowlistPath: request.hitlAllowlistPath ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_config', usage: {}, cost: 0 });
} else if (request.prompt === 'hitl-config') {
  const text = JSON.stringify({ hitlMode: request.hitlMode ?? null, hitlReviewModel: request.hitlReviewModel ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_hitl', usage: {}, cost: 0 });
} else if (request.prompt === 'auto-decision') {
  emit({ type: 'auto_decision', sessionId: 'hao_auto', interruptId: 'int_auto', actionId: 'act_auto', toolName: 'Bash', toolInput: { command: 'pwd' }, decision: 'approve', source: 'rule', riskLevel: 'low', reason: 'Read-only command allowlist' });
  emit({ type: 'text', text: 'auto continued' });
  emit({ type: 'result', text: 'auto continued', sessionId: 'hao_auto', usage: {}, cost: 0 });
} else if (request.prompt === 'auto-decision-sandbox') {
  emit({ type: 'auto_decision', sessionId: 'hao_sandbox', interruptId: 'int_sandbox', actionId: 'act_sandbox', toolName: 'Bash', toolInput: { command: 'make build' }, decision: 'approve', source: 'sandbox', riskLevel: 'low', reason: 'sandbox:contained: Runs inside the configured sandbox.' });
  emit({ type: 'text', text: 'auto continued' });
  emit({ type: 'result', text: 'auto continued', sessionId: 'hao_sandbox', usage: {}, cost: 0 });
} else if (request.prompt === 'escalate-decision') {
  emit({ type: 'auto_decision', sessionId: 'hao_esc', interruptId: 'int_esc', actionId: 'act_esc', toolName: 'Bash', toolInput: { command: 'sudo ls' }, decision: 'escalate', source: 'rule', riskLevel: 'high', reason: "rule:red_line: Red-line command 'sudo': privilege escalation." });
  emit({ type: 'interrupt', interrupt: { id: 'int_esc', session_id: 'hao_esc', actions: [{ id: 'act_esc', tool_name: 'Bash', input: { command: 'sudo ls' }, description: 'Run sudo ls', allowed_decisions: ['approve', 'reject'] }], created_at: new Date().toISOString() } });
} else if (request.prompt === 'auto-decision-flood') {
  for (let index = 0; index < 105; index += 1) {
    emit({ type: 'auto_decision', sessionId: 'hao_flood', interruptId: 'int_flood', actionId: 'act_flood_' + index, toolName: 'Read', toolInput: { file_path: 'f' + index + '.txt' }, decision: 'approve', source: 'review', riskLevel: 'medium', reason: 'flood ' + index });
  }
  emit({ type: 'result', text: 'flooded', sessionId: 'hao_flood', usage: {}, cost: 0 });
} else if (request.prompt === 'todos') {
  emit({ type: 'tool_start', toolName: 'TodoWrite', toolInput: { todos: [{ content: 'Ship it', status: 'in_progress', priority: 'high' }] } });
  emit({ type: 'tool_result', toolName: 'TodoWrite', toolOutput: 'updated', toolIsError: false });
  emit({ type: 'result', text: 'done', sessionId: 'hao_todos', usage: {}, cost: 0 });
} else {
  emit({ type: 'text', text: 'hello ' });
  emit({ type: 'tool_start', toolName: 'Read', toolInput: { file_path: 'README.md' } });
  emit({ type: 'tool_result', toolName: 'Read', toolOutput: '# Fixture', toolIsError: false });
  emit({ type: 'text', text: 'world' });
  emit({ type: 'result', text: 'hello world', sessionId: 'hao_1', usage: { input_tokens: 3, output_tokens: 2 }, cost: 0.002 });
}
`);
  const runtime = createHaoCodeCompatibilityServer({
    dataDir,
    logger: { log() {}, error() {} },
    workerOptions: { phpBinary: process.execPath, workerPath: worker },
    modelsMetadataLoader,
  });
  await runtime.start();
  runtimes.push(runtime);
  temporaryDirectories.push(root);
  return { runtime, project, dataDir, worker, baseUrl: `http://127.0.0.1:${runtime.getPort()}` };
};

const createSession = async ({ baseUrl, project }) => {
  const response = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test session' }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const configureDeepSeek = async (baseUrl) => {
  const response = await fetch(`${baseUrl}/auth/deepseek`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'api', key: 'test-key' }),
  });
  expect(await response.json()).toBe(true);
};

const prompt = (baseUrl, project, sessionId, text, overrides = {}) => fetch(
  `${baseUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(project)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageID: `msg_user_${text}`,
      model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      agent: overrides.agent || 'build',
      parts: [{ type: 'text', text }],
      ...overrides,
    }),
  },
);

const waitFor = async (callback, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for compatibility runtime state.');
};

const readSseEvent = async (response, type, timeoutMs = 5000) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
      ]);
      if (read === null || read.done) return null;
      buffer += decoder.decode(read.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice(6));
        if (payload.type === type) return payload;
      }
    }
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
};

const waitForAssistantStop = async (baseUrl, sessionId) => waitFor(async () => {
  const messages = await fetch(`${baseUrl}/session/${sessionId}/message`).then((item) => item.json());
  const stopped = messages.filter((record) => record.info.role === 'assistant' && record.info.finish === 'stop');
  return stopped.length ? stopped : null;
});

// Drive one always-allow reply for an arbitrary Bash command and return the
// persisted allowlist rules. The allowlist file is removed first so each
// command is asserted in isolation. The reply triggers a resume run, so the
// helper waits for that run to finish before returning — prompting while the
// session is still busy would drop the next interrupt.
const alwaysAllowRules = async (runtime, session, command) => {
  const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
  await fs.rm(allowlistPath, { force: true });
  const stoppedCount = async () => (await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json()))
    .filter((record) => record.info.role === 'assistant' && record.info.finish === 'stop').length;
  expect((await prompt(runtime.baseUrl, runtime.project, session.id, `interrupt-cmd:${command}`)).status).toBe(200);
  const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
  expect(permission.metadata.command).toBe(command);
  const stoppedBefore = await stoppedCount();
  const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply: 'always' }),
  });
  expect(await reply.json()).toBe(true);
  await waitFor(async () => (await stoppedCount()) > stoppedBefore ? true : null);
  const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
  expect(allowlist.version).toBe(2);
  return allowlist.rules;
};

describe('HaoCode compatibility server', () => {
  test('loads project agents, commands, and MCP into HaoCode runs', async () => {
    const runtime = await createRuntime();
    await fs.mkdir(path.join(runtime.project, '.opencode'), { recursive: true });
    await fs.writeFile(path.join(runtime.project, '.opencode', 'opencode.json'), JSON.stringify({
      agent: { reviewer: { description: 'Review code', prompt: 'Be exact.' } },
      command: { inspect: { description: 'Inspect code', template: 'Inspect $ARGUMENTS' } },
      mcp: { context7: { type: 'remote', url: 'https://mcp.example.test', enabled: true } },
    }));

    const agents = await fetch(`${runtime.baseUrl}/agent?directory=${encodeURIComponent(runtime.project)}`).then((response) => response.json());
    expect(agents).toContainEqual(expect.objectContaining({ name: 'reviewer', prompt: 'Be exact.' }));
    const commands = await fetch(`${runtime.baseUrl}/command?directory=${encodeURIComponent(runtime.project)}`).then((response) => response.json());
    expect(commands).toContainEqual(expect.objectContaining({ name: 'inspect', template: 'Inspect $ARGUMENTS' }));
    const mcp = await fetch(`${runtime.baseUrl}/mcp?directory=${encodeURIComponent(runtime.project)}`).then((response) => response.json());
    expect(mcp.context7).toEqual({ status: 'connected' });

    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'request-config', { agent: 'reviewer' })).status).toBe(200);
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((response) => response.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const config = JSON.parse(records.find((record) => record.info.role === 'assistant').parts.find((part) => part.type === 'text').text);
    expect(config.appendSystemPrompt).toBe('Be exact.');
    expect(config.allowedTools).toEqual(['*']);
    expect(config.hitlAllowlistPath).toBe(path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json'));
    expect(JSON.parse(await fs.readFile(config.mcpSettingsPath, 'utf8')).mcp_servers.context7).toMatchObject({ transport: 'http', url: 'https://mcp.example.test' });
  });

  test('exposes TodoWrite state and Git-backed status and diffs', async () => {
    const runtime = await createRuntime();
    await execFileAsync('git', ['init'], { cwd: runtime.project });
    await execFileAsync('git', ['add', 'README.md'], { cwd: runtime.project });
    await execFileAsync('git', ['-c', 'user.name=Hao Work Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: runtime.project });
    await fs.appendFile(path.join(runtime.project, 'README.md'), 'Changed\n');
    await fs.writeFile(path.join(runtime.project, 'new.txt'), 'one\ntwo\n');

    const status = await fetch(`${runtime.baseUrl}/vcs/status?directory=${encodeURIComponent(runtime.project)}`).then((response) => response.json());
    expect(status).toContainEqual(expect.objectContaining({ file: 'README.md', status: 'modified' }));
    expect(status).toContainEqual(expect.objectContaining({ file: 'new.txt', status: 'added' }));
    const fileStatus = await fetch(`${runtime.baseUrl}/file/status?directory=${encodeURIComponent(runtime.project)}`).then((response) => response.json());
    expect(fileStatus).toContainEqual(expect.objectContaining({ path: 'new.txt', status: 'added' }));

    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'todos')).status).toBe(200);
    const todos = await waitFor(async () => {
      const value = await fetch(`${runtime.baseUrl}/session/${session.id}/todo`).then((response) => response.json());
      return value.length ? value : null;
    });
    expect(todos).toEqual([{ content: 'Ship it', status: 'in_progress', priority: 'high' }]);
    const diffs = await fetch(`${runtime.baseUrl}/session/${session.id}/diff`).then((response) => response.json());
    expect(diffs).toContainEqual(expect.objectContaining({ path: 'README.md', status: 'modified' }));
  });
  test('boots without OpenCode and exposes project, provider, and file contracts', async () => {
    const { baseUrl, project } = await createRuntime();
    const health = await fetch(`${baseUrl}/global/health`).then((response) => response.json());
    expect(health).toMatchObject({
      healthy: true,
      _fe_agentEngine: 'haocode',
      _fe_haocodeVersion: '9.8.7',
    });

    const providers = await fetch(`${baseUrl}/config/providers`).then((response) => response.json());
    expect(providers.providers.map((provider) => provider.id)).toContain('deepseek');
    expect(providers.providers.find((provider) => provider.id === 'deepseek').models['deepseek-chat'].limit).toEqual({
      context: 1_000_000,
      output: 384_000,
    });

    const sourceBefore = await fetch(`${baseUrl}/provider/deepseek/source`).then((response) => response.json());
    expect(sourceBefore.sources.auth.exists).toBe(false);
    await configureDeepSeek(baseUrl);
    const sourceAfter = await fetch(`${baseUrl}/provider/deepseek/source`).then((response) => response.json());
    expect(sourceAfter.sources.auth.exists).toBe(true);

    const customSettings = await fetch(`${baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://gateway.example.test/anthropic', providerType: 'anthropic', model: 'deepseek-custom' }),
    }).then((response) => response.json());
    expect(customSettings).toMatchObject({
      baseUrl: 'https://gateway.example.test/anthropic',
      providerType: 'anthropic',
      models: ['deepseek-custom'],
    });

    const files = await fetch(`${baseUrl}/file?directory=${encodeURIComponent(project)}&path=.`).then((response) => response.json());
    expect(files).toContainEqual(expect.objectContaining({ name: 'README.md', type: 'file' }));
  });

  test('uses the same catalog limits for provider display and HaoCode execution', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'limits')).status).toBe(200);

    const providers = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    const displayedLimit = providers.providers
      .find((provider) => provider.id === 'deepseek')
      .models['deepseek-chat'].limit;
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const workerLimit = JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);

    expect(workerLimit).toEqual(displayedLimit);
  });

  test('keeps provider display and execution aligned on HaoCode defaults when metadata is unavailable', async () => {
    const runtime = await createRuntime({
      modelsMetadataLoader: async () => { throw new Error('offline'); },
    });
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'limits')).status).toBe(200);

    const providers = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    const displayedLimit = providers.providers
      .find((provider) => provider.id === 'deepseek')
      .models['deepseek-chat'].limit;
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const workerLimit = JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);

    expect(displayedLimit).toEqual({ context: 200_000, output: 16_384 });
    expect(workerLimit).toEqual(displayedLimit);
  });

  test('persists sessions and translates text and tool events into message snapshots', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'hello');
    expect(response.status).toBe(200);

    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const assistant = records.find((record) => record.info.role === 'assistant');
    expect(assistant.parts.find((part) => part.type === 'text').text).toBe('hello world');
    expect(assistant.parts.find((part) => part.type === 'tool')).toMatchObject({
      tool: 'Read',
      state: { status: 'completed', output: '# Fixture' },
    });
    const persistedSession = await fetch(`${runtime.baseUrl}/session/${session.id}`).then((item) => item.json());
    expect(persistedSession.metadata._fe_haocodeSessionId).toBe('hao_1');
  });

  test('maps a HaoCode interrupt to permission reply and resumes the durable session', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt')).status).toBe(200);

    const permission = await waitFor(async () => {
      const pending = await fetch(`${runtime.baseUrl}/permission?directory=${encodeURIComponent(runtime.project)}`).then((item) => item.json());
      return pending[0] ?? null;
    });
    expect(permission.permission).toBe('Bash');
    // The command must be visible to reviewers: top-level metadata for the
    // card's bash layout, and patterns for the pattern row.
    expect(permission.patterns).toEqual(['pwd']);
    expect(permission.metadata.command).toBe('pwd');
    expect(permission.metadata.input).toEqual({ command: 'pwd' });
    expect(permission.metadata.description).toBe('Run pwd');

    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'once' }),
    });
    expect(await reply.json()).toBe(true);

    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.type === 'text' && part.text === 'continued')) ? messages : null;
    });
    expect(records.some((record) => record.parts.some((part) => part.text === 'continued'))).toBe(true);
  });

  test('rejects a Bash interrupt and resumes with the rejection decision', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt')).status).toBe(200);
    const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'reject' }),
    });
    expect(reply.status).toBe(200);
    await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.text === 'rejected'));
    });
  });

  test('answers AskUserQuestion and continues the same durable HaoCode session', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'question')).status).toBe(200);
    const question = await waitFor(async () => (await fetch(`${runtime.baseUrl}/question`).then((item) => item.json()))[0] ?? null);
    expect(question.questions[0].question).toBe('Continue?');
    const reply = await fetch(`${runtime.baseUrl}/question/${question.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['Yes']] }),
    });
    expect(reply.status).toBe(200);
    await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.text === 'answered'));
    });
    const persisted = await fetch(`${runtime.baseUrl}/session/${session.id}`).then((item) => item.json());
    expect(persisted.metadata._fe_haocodeSessionId).toBe('hao_question');
  });

  test('accepts each decision of a multi-action interrupt before resuming once', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'multi-interrupt')).status).toBe(200);

    const permissions = await waitFor(async () => {
      const pending = await fetch(`${runtime.baseUrl}/permission?directory=${encodeURIComponent(runtime.project)}`).then((item) => item.json());
      return pending.length === 2 ? pending : null;
    });
    const bashPermission = permissions.find((item) => item.permission === 'Bash');
    const writePermission = permissions.find((item) => item.permission === 'Write');
    expect(bashPermission?.patterns).toEqual(['pwd']);
    expect(writePermission?.patterns).toEqual(['result.txt']);
    expect(writePermission?.metadata.file_path).toBe('result.txt');
    for (const permission of permissions) {
      const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'once' }),
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toBe(true);
    }

    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.type === 'text' && part.text === 'continued')) ? messages : null;
    });
    expect(records.filter((record) => record.parts.some((part) => part.text === 'continued'))).toHaveLength(1);
  });

  test('aborts an active worker and returns the session to idle', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'wait')).status).toBe(200);
    await waitFor(async () => runtime.runtime.supervisor.isRunning(session.id));

    const aborted = await fetch(`${runtime.baseUrl}/session/${session.id}/abort`, { method: 'POST' });
    expect(await aborted.json()).toBe(true);
    await waitFor(async () => !runtime.runtime.supervisor.isRunning(session.id));
    const statuses = await fetch(`${runtime.baseUrl}/session/status`).then((item) => item.json());
    expect(statuses[session.id]).toBeUndefined();
  });

  test('keeps concurrent session events isolated', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const first = await createSession(runtime);
    const second = await createSession(runtime);
    await Promise.all([
      prompt(runtime.baseUrl, runtime.project, first.id, 'session-a'),
      prompt(runtime.baseUrl, runtime.project, second.id, 'session-b'),
    ]);
    const [firstMessages, secondMessages] = await waitFor(async () => {
      const left = await fetch(`${runtime.baseUrl}/session/${first.id}/message`).then((item) => item.json());
      const right = await fetch(`${runtime.baseUrl}/session/${second.id}/message`).then((item) => item.json());
      const leftDone = left.some((record) => record.parts.some((part) => part.text === 'session-a'));
      const rightDone = right.some((record) => record.parts.some((part) => part.text === 'session-b'));
      return leftDone && rightDone ? [left, right] : null;
    });
    expect(firstMessages.some((record) => record.parts.some((part) => part.text === 'session-b'))).toBe(false);
    expect(secondMessages.some((record) => record.parts.some((part) => part.text === 'session-a'))).toBe(false);
  });

  test('persists sessions and messages across compatibility runtime restarts', async () => {
    const fixture = await createRuntime();
    await configureDeepSeek(fixture.baseUrl);
    const session = await createSession(fixture);
    expect((await prompt(fixture.baseUrl, fixture.project, session.id, 'hello')).status).toBe(200);
    await waitFor(async () => {
      const messages = await fetch(`${fixture.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.info.finish === 'stop');
    });
    await fixture.runtime.stop();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);

    const restarted = createHaoCodeCompatibilityServer({
      dataDir: fixture.dataDir,
      logger: { log() {}, error() {} },
      workerOptions: { phpBinary: process.execPath, workerPath: fixture.worker },
    });
    await restarted.start();
    runtimes.push(restarted);
    const baseUrl = `http://127.0.0.1:${restarted.getPort()}`;
    const restored = await fetch(`${baseUrl}/session/${session.id}`).then((item) => item.json());
    const messages = await fetch(`${baseUrl}/session/${session.id}/message`).then((item) => item.json());
    expect(restored.id).toBe(session.id);
    expect(messages.some((record) => record.parts.some((part) => part.text === 'hello world'))).toBe(true);
  });

  test('keeps parent user messages when a limited page contains only assistant turns', async () => {
    const runtime = await createRuntime();
    const session = await createSession(runtime);
    const userMessageId = 'msg_user_long_task';
    await runtime.runtime.store.mutate((state) => {
      state.messages[session.id] = [
        {
          info: { id: userMessageId, sessionID: session.id, role: 'user', time: { created: 1 } },
          parts: [{ id: 'part_user', sessionID: session.id, messageID: userMessageId, type: 'text', text: 'long task' }],
        },
        ...Array.from({ length: 60 }, (_, index) => ({
          info: {
            id: `msg_assistant_${String(index).padStart(2, '0')}`,
            sessionID: session.id,
            role: 'assistant',
            parentID: userMessageId,
            time: { created: index + 2, completed: index + 2 },
          },
          parts: [{
            id: `part_assistant_${index}`,
            sessionID: session.id,
            messageID: `msg_assistant_${String(index).padStart(2, '0')}`,
            type: 'text',
            text: `turn ${index}`,
          }],
        })),
      ];
    });

    const latestResponse = await fetch(`${runtime.baseUrl}/session/${session.id}/message?limit=50`);
    const latest = await latestResponse.json();
    expect(latest[0].info.id).toBe(userMessageId);
    expect(latest.filter((record) => record.info.role === 'assistant')).toHaveLength(50);
    expect(latestResponse.headers.get('x-next-cursor')).toBe('msg_assistant_10');

    const olderResponse = await fetch(`${runtime.baseUrl}/session/${session.id}/message?limit=50&before=msg_assistant_10`);
    const older = await olderResponse.json();
    expect(older.map((record) => record.info.id)).toEqual([
      userMessageId,
      ...Array.from({ length: 10 }, (_, index) => `msg_assistant_${String(index).padStart(2, '0')}`),
    ]);
    expect(olderResponse.headers.get('x-next-cursor')).toBeNull();
  });

  test('surfaces missing auth, empty responses, and worker crashes as failures', async () => {
    const runtime = await createRuntime();
    const session = await createSession(runtime);
    const unauthorized = await prompt(runtime.baseUrl, runtime.project, session.id, 'hello');
    expect(unauthorized.status).toBe(401);
    await configureDeepSeek(runtime.baseUrl);

    for (const failurePrompt of ['empty', 'crash']) {
      expect((await prompt(runtime.baseUrl, runtime.project, session.id, failurePrompt)).status).toBe(200);
      const errorRecord = await waitFor(async () => {
        const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
        return [...messages].reverse().find((record) => record.info.role === 'assistant' && record.info.finish === 'error');
      });
      expect(errorRecord.info.error.data.message).toBeTruthy();
    }
  });

  test('translates worker auto_decision into permission.auto_resolved without a pending card', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const sseResponse = await fetch(`${runtime.baseUrl}/event?directory=${encodeURIComponent(runtime.project)}`);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'auto-decision')).status).toBe(200);
    const payload = await readSseEvent(sseResponse, 'permission.auto_resolved');
    expect(payload).not.toBeNull();
    expect(payload.properties.sessionID).toBe(session.id);
    expect(payload.properties.requestID).toBe('req_act_auto');
    expect(payload.properties.permission).toBe('Bash');
    expect(payload.properties.metadata).toMatchObject({
      input: { command: 'pwd' },
      description: 'Read-only command allowlist',
      _fe_interruptId: 'int_auto',
      _fe_actionId: 'act_auto',
      _fe_autoDecision: 'approve',
      _fe_source: 'rule',
      _fe_riskLevel: 'low',
    });

    await waitForAssistantStop(runtime.baseUrl, session.id);
    const pending = await fetch(`${runtime.baseUrl}/permission?directory=${encodeURIComponent(runtime.project)}`).then((item) => item.json());
    expect(pending).toEqual([]);

    const records = await runtime.runtime.store.read((state) => state.autoDecisions[session.id] ?? []);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: session.id,
      interruptId: 'int_auto',
      actionId: 'act_auto',
      tool: 'Bash',
      input: { command: 'pwd' },
      decision: 'approve',
      source: 'rule',
      riskLevel: 'low',
      reason: 'Read-only command allowlist',
    });
  });

  test('merges smart-mode escalation context into the pending permission metadata', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const sseResponse = await fetch(`${runtime.baseUrl}/event?directory=${encodeURIComponent(runtime.project)}`);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'escalate-decision')).status).toBe(200);

    // The escalate line must not surface as permission.auto_resolved; the
    // first permission-related SSE event is the interrupt's permission.asked.
    const asked = await readSseEvent(sseResponse, 'permission.asked');
    expect(asked).not.toBeNull();
    expect(asked.properties.metadata).toMatchObject({
      _fe_interruptId: 'int_esc',
      _fe_actionId: 'act_esc',
      _fe_escalationReason: "rule:red_line: Red-line command 'sudo': privilege escalation.",
      _fe_escalationSource: 'rule',
      _fe_escalationRisk: 'high',
    });

    const permission = await waitFor(async () => {
      const pending = await fetch(`${runtime.baseUrl}/permission?directory=${encodeURIComponent(runtime.project)}`).then((item) => item.json());
      return pending[0] ?? null;
    });
    expect(permission.metadata._fe_escalationReason).toBe("rule:red_line: Red-line command 'sudo': privilege escalation.");
    expect(permission.metadata._fe_escalationSource).toBe('rule');
    expect(permission.metadata._fe_escalationRisk).toBe('high');

    // Escalations are not auto decisions: no audit record, no resolved card.
    const records = await runtime.runtime.store.read((state) => state.autoDecisions[session.id] ?? []);
    expect(records).toEqual([]);
  });

  test('normalizes sandbox-sourced auto decisions into the audit trail', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const sseResponse = await fetch(`${runtime.baseUrl}/event?directory=${encodeURIComponent(runtime.project)}`);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'auto-decision-sandbox')).status).toBe(200);
    const payload = await readSseEvent(sseResponse, 'permission.auto_resolved');
    expect(payload).not.toBeNull();
    expect(payload.properties.metadata).toMatchObject({
      input: { command: 'make build' },
      _fe_autoDecision: 'approve',
      _fe_source: 'sandbox',
      _fe_riskLevel: 'low',
    });

    await waitForAssistantStop(runtime.baseUrl, session.id);
    const records = await runtime.runtime.store.read((state) => state.autoDecisions[session.id] ?? []);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: 'Bash',
      input: { command: 'make build' },
      decision: 'approve',
      source: 'sandbox',
      riskLevel: 'low',
      reason: 'sandbox:contained: Runs inside the configured sandbox.',
    });
  });

  test('persists an always-allow Bash reply into the HITL allowlist file', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt')).status).toBe(200);

    const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'always' }),
    });
    expect(await reply.json()).toBe(true);

    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
    const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(allowlist.version).toBe(2);
    expect(allowlist.rules).toHaveLength(1);
    expect(allowlist.rules[0]).toMatchObject({ type: 'prefix', tokens: ['pwd'], source: 'user' });
    expect(typeof allowlist.rules[0].addedAt).toBe('string');

    await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.text === 'continued')) ? true : null;
    });
  });

  test('trims and dedupes allowlist commands and forwards the path on resume', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');

    const replyAlways = async () => {
      const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
      const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'always' }),
      });
      expect(await reply.json()).toBe(true);
      await waitFor(async () => {
        const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
        return messages.some((record) => record.parts.some((part) => part.text.includes('hitlAllowlistPath'))) ? true : null;
      });
    };

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt-probe')).status).toBe(200);
    await replyAlways();

    // The resumed worker request carried the allowlist path.
    const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
    const probeText = messages.flatMap((record) => record.parts).find((part) => part.text?.includes('hitlAllowlistPath'))?.text;
    expect(JSON.parse(probeText).hitlAllowlistPath).toBe(allowlistPath);

    // The command was trimmed before deriving rules.
    const first = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(first.version).toBe(2);
    expect(first.rules).toHaveLength(1);
    expect(first.rules[0]).toMatchObject({ type: 'prefix', tokens: ['ls'] });

    // A second always-allow of the same command is deduped.
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt-probe')).status).toBe(200);
    await replyAlways();
    const second = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(second.rules).toHaveLength(1);
  });

  test('rebuilds a corrupted HITL allowlist file on always-allow', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
    await fs.mkdir(path.dirname(allowlistPath), { recursive: true });
    await fs.writeFile(allowlistPath, 'not json {{{');

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt')).status).toBe(200);
    const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'always' }),
    });
    expect(await reply.json()).toBe(true);

    const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(allowlist.version).toBe(2);
    expect(allowlist.rules).toHaveLength(1);
    expect(allowlist.rules[0]).toMatchObject({ type: 'prefix', tokens: ['pwd'] });
  });

  test('does not persist always-allow replies for non-Bash tools', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'multi-interrupt')).status).toBe(200);

    const permissions = await waitFor(async () => {
      const pending = await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json());
      return pending.length === 2 ? pending : null;
    });
    const writePermission = permissions.find((item) => item.permission === 'Write');
    const bashPermission = permissions.find((item) => item.permission === 'Bash');
    for (const [target, decision] of [[writePermission, 'always'], [bashPermission, 'once']]) {
      const reply = await fetch(`${runtime.baseUrl}/permission/${target.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: decision }),
      });
      expect(await reply.json()).toBe(true);
    }

    await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.parts.some((part) => part.text === 'continued')) ? true : null;
    });
    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
    await expect(fs.access(allowlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('derives codex-style prefix and exact rules for always-allowed Bash commands', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const cases = [
      ['git commit -m x', [{ type: 'prefix', tokens: ['git', 'commit'] }]],
      ['npm run build', [{ type: 'prefix', tokens: ['npm', 'run', 'build'] }]],
      ['npm exec tsc --noEmit', [{ type: 'prefix', tokens: ['npm', 'exec', 'tsc'] }]],
      ['npm install', [{ type: 'prefix', tokens: ['npm', 'install'] }]],
      ['make -j4', [{ type: 'prefix', tokens: ['make'] }]],
      ['ls -la', [{ type: 'prefix', tokens: ['ls'] }]],
      ['sudo ls', [{ type: 'exact', command: 'sudo ls' }]],
      ['node foo.js', [{ type: 'exact', command: 'node foo.js' }]],
      ['./bin/tool --x', [{ type: 'exact', command: './bin/tool --x' }]],
      ['echo hi > /tmp/a', [{ type: 'exact', command: 'echo hi > /tmp/a' }]],
      ['git diff > /tmp/out.txt', [{ type: 'exact', command: 'git diff > /tmp/out.txt' }]],
      ['make | tee /tmp/log', [{ type: 'prefix', tokens: ['make'] }, { type: 'exact', command: 'tee /tmp/log' }]],
      ['echo hi > /dev/null', [{ type: 'prefix', tokens: ['echo'] }]],
      ['make 2>&1 | grep err', [{ type: 'prefix', tokens: ['make'] }, { type: 'prefix', tokens: ['grep'] }]],
      ['FOO=bar BAZ=qux git status', [{ type: 'prefix', tokens: ['git', 'status'] }]],
      ['cd /a && make -j4 && grep x y', [
        { type: 'prefix', tokens: ['cd'] },
        { type: 'prefix', tokens: ['make'] },
        { type: 'prefix', tokens: ['grep'] },
      ]],
      // Duplicate segments within one command collapse to a single rule.
      ['ls && ls', [{ type: 'prefix', tokens: ['ls'] }]],
    ];

    for (const [command, expected] of cases) {
      const rules = await alwaysAllowRules(runtime, session, command);
      expect(rules).toEqual(expected.map((rule) => expect.objectContaining(rule)));
    }
  });

  test('stores an always-allowed heredoc command as one exact rule', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const command = 'cat > /tmp/a << EOF\nhello\nEOF';
    const rules = await alwaysAllowRules(runtime, session, command);
    expect(rules).toEqual([expect.objectContaining({ type: 'exact', command })]);
  });

  test('keeps legacy v1 allowlist entries unchanged and appends v2 rules', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
    await fs.mkdir(path.dirname(allowlistPath), { recursive: true });
    const legacy = { command: 'sudo legacy --cmd', addedAt: '2024-01-02T03:04:05.000Z', source: 'user' };
    await fs.writeFile(allowlistPath, `${JSON.stringify({ version: 1, rules: [legacy] }, null, 2)}\n`);

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt-cmd:git status')).status).toBe(200);
    const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'always' }),
    });
    expect(await reply.json()).toBe(true);

    const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(allowlist.version).toBe(2);
    expect(allowlist.rules).toHaveLength(2);
    expect(allowlist.rules[0]).toEqual(legacy);
    expect(allowlist.rules[1]).toMatchObject({ type: 'prefix', tokens: ['git', 'status'], source: 'user' });
  });

  test('dedupes a new exact rule against a legacy v1 entry without rewriting', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const allowlistPath = path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json');
    await fs.mkdir(path.dirname(allowlistPath), { recursive: true });
    const legacy = { command: 'sudo ls', addedAt: '2024-01-02T03:04:05.000Z', source: 'user' };
    await fs.writeFile(allowlistPath, `${JSON.stringify({ version: 1, rules: [legacy] }, null, 2)}\n`);

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'interrupt-cmd:sudo ls')).status).toBe(200);
    const permission = await waitFor(async () => (await fetch(`${runtime.baseUrl}/permission`).then((item) => item.json()))[0] ?? null);
    const reply = await fetch(`${runtime.baseUrl}/permission/${permission.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'always' }),
    });
    expect(await reply.json()).toBe(true);

    // Nothing new to persist: the file is left untouched (still v1, one rule).
    const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
    expect(allowlist.version).toBe(1);
    expect(allowlist.rules).toEqual([legacy]);
  });

  test('serves persisted auto-decision history through GET /auto-decisions', async () => {
    const runtime = await createRuntime();

    const missing = await fetch(`${runtime.baseUrl}/auto-decisions`);
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${runtime.baseUrl}/auto-decisions?sessionID=ses_unknown`);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual([]);

    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'auto-decision')).status).toBe(200);
    await waitForAssistantStop(runtime.baseUrl, session.id);

    const response = await fetch(`${runtime.baseUrl}/auto-decisions?sessionID=${encodeURIComponent(session.id)}`);
    expect(response.status).toBe(200);
    const records = await response.json();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: session.id,
      interruptId: 'int_auto',
      actionId: 'act_auto',
      tool: 'Bash',
      input: { command: 'pwd' },
      decision: 'approve',
      source: 'rule',
      riskLevel: 'low',
      reason: 'Read-only command allowlist',
    });
    expect(typeof records[0].id).toBe('string');
    expect(typeof records[0].time).toBe('number');
    expect(records[0]).not.toHaveProperty('directory');
  });

  test('caps persisted auto-decision history at 100 entries per session', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'auto-decision-flood')).status).toBe(200);
    await waitForAssistantStop(runtime.baseUrl, session.id);

    const records = await runtime.runtime.store.read((state) => state.autoDecisions[session.id] ?? []);
    expect(records).toHaveLength(100);
    expect(records[0]).toMatchObject({ actionId: 'act_flood_5', reason: 'flood 5' });
    expect(records.at(-1)).toMatchObject({ actionId: 'act_flood_104', reason: 'flood 104' });
  });

  test('forwards normalized HITL mode config to every worker request', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    let stoppedCount = 0;
    const echoedHitlConfig = async () => {
      expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'hitl-config')).status).toBe(200);
      const stopped = await waitFor(async () => {
        const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
        const list = messages.filter((record) => record.info.role === 'assistant' && record.info.finish === 'stop');
        return list.length > stoppedCount ? list : null;
      });
      stoppedCount = stopped.length;
      return JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    };

    expect(await echoedHitlConfig()).toEqual({ hitlMode: 'smart', hitlReviewModel: null });

    const patched = await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _fe_hitlMode: 'smart', _fe_hitlReviewModel: 'deepseek-reasoner' }),
    });
    expect(patched.status).toBe(200);
    expect(await echoedHitlConfig()).toEqual({ hitlMode: 'smart', hitlReviewModel: 'deepseek-reasoner' });

    await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _fe_hitlMode: 'bogus' }),
    });
    expect(await echoedHitlConfig()).toEqual({ hitlMode: 'smart', hitlReviewModel: 'deepseek-reasoner' });
  });
});
