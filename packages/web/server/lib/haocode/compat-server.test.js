import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createHaoCodeCompatibilityServer } from './compat-server.js';
import { createImageConverters } from './image-converters.js';

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
          'deepseek-v4-flash': { limit: { context: 1_000_000, output: 384_000 } },
        },
      },
    },
  }),
  ...serverOptions
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
  const text = JSON.stringify({ appendSystemPrompt: request.appendSystemPrompt ?? null, agent: request.agent ?? null, mcpSettingsPath: request.mcpSettingsPath, allowedTools: request.allowedTools, hitlAllowlistPath: request.hitlAllowlistPath ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_config', usage: {}, cost: 0 });
} else if (request.prompt === 'hitl-config') {
  const text = JSON.stringify({ hitlMode: request.hitlMode ?? null, hitlReviewModel: request.hitlReviewModel ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_hitl', usage: {}, cost: 0 });
} else if (request.prompt === 'sandbox-config') {
  const sandbox = request.sandbox ?? { enabled: false };
  const text = JSON.stringify(sandbox);
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_sandbox_cfg', usage: {}, cost: 0 });
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
} else if (request.prompt === 'provider-probe') {
  const text = JSON.stringify({ apiKey: request.provider?.apiKey ?? null, oauthBearer: request.provider?.oauthBearer ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_provider_probe', usage: {}, cost: 0 });
} else if (request.prompt === 'provider-headers-probe') {
  const text = JSON.stringify({ apiKey: request.provider?.apiKey ?? null, headers: request.provider?.headers ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_provider_headers', usage: {}, cost: 0 });
} else if (typeof request.prompt === 'string' && request.prompt.startsWith('images-probe')) {
  const text = JSON.stringify({ prompt: request.prompt ?? null, images: request.images ?? null });
  emit({ type: 'text', text });
  emit({ type: 'result', text, sessionId: 'hao_images_probe', usage: {}, cost: 0 });
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
    workerOptions: { phpBinary: process.execPath, phpArgs: [], workerPath: worker },
    modelsMetadataLoader,
    ...serverOptions,
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
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
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
    expect(config.agent).toEqual({ name: 'reviewer', prompt: 'Be exact.' });
    expect(config.appendSystemPrompt).toBeNull();
    expect(config.allowedTools).toEqual(['*']);
    expect(config.hitlAllowlistPath).toBe(path.join(runtime.dataDir, 'haocode', 'hitl-allowlist.json'));
    expect(JSON.parse(await fs.readFile(config.mcpSettingsPath, 'utf8')).mcp_servers.context7).toMatchObject({ transport: 'http', url: 'https://mcp.example.test' });
  });

  test('forwards structured agent definitions and pinned models to the worker', async () => {
    const runtime = await createRuntime();
    await fs.mkdir(path.join(runtime.project, '.opencode'), { recursive: true });
    await fs.writeFile(path.join(runtime.project, '.opencode', 'opencode.json'), JSON.stringify({
      agent: {
        pilot: { prompt: 'Fly carefully.', model: 'deepseek/deepseek-reasoner' },
        navigator: { prompt: 'Chart the course.', model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' } },
      },
    }));

    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const stoppedRecords = async () => (await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json()))
      .filter((record) => record.info.role === 'assistant' && record.info.finish === 'stop');
    const requestConfig = async (agent) => {
      const stoppedBefore = (await stoppedRecords()).length;
      expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'request-config', agent ? { agent } : {})).status).toBe(200);
      const stopped = await waitFor(async () => {
        const records = await stoppedRecords();
        return records.length > stoppedBefore ? records : null;
      });
      return JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    };

    // String "provider/model" pins are parsed into a structured model override.
    const pinned = await requestConfig('pilot');
    expect(pinned.agent).toEqual({
      name: 'pilot',
      prompt: 'Fly carefully.',
      model: { providerID: 'deepseek', modelID: 'deepseek-reasoner' },
    });

    // Object-shaped pins pass through with trimmed providerID/modelID.
    const objectPinned = await requestConfig('navigator');
    expect(objectPinned.agent).toEqual({
      name: 'navigator',
      prompt: 'Chart the course.',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });

    // The default build agent carries only its name — no prompt, no model —
    // matching the previous behavior where no appendSystemPrompt was sent.
    const build = await requestConfig();
    expect(build.agent).toEqual({ name: 'build' });
    expect(build.appendSystemPrompt).toBeNull();
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
    expect(providers.providers.find((provider) => provider.id === 'deepseek').models['deepseek-v4-flash'].limit).toEqual({
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
      .models['deepseek-v4-flash'].limit;
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
      .models['deepseek-v4-flash'].limit;
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
    // Narration is split at tool boundaries so parts stay chronological:
    // [text 'hello ', tool Read, text 'world'] instead of one consolidated
    // text block with every tool card sunk below it.
    expect(assistant.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')).toBe('hello world');
    expect(assistant.parts.map((part) => part.type)).toEqual(['text', 'tool', 'text']);
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
      workerOptions: { phpBinary: process.execPath, phpArgs: [], workerPath: fixture.worker },
    });
    await restarted.start();
    runtimes.push(restarted);
    const baseUrl = `http://127.0.0.1:${restarted.getPort()}`;
    const restored = await fetch(`${baseUrl}/session/${session.id}`).then((item) => item.json());
    const messages = await fetch(`${baseUrl}/session/${session.id}/message`).then((item) => item.json());
    expect(restored.id).toBe(session.id);
    expect(messages.some((record) => record.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') === 'hello world')).toBe(true);
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

  test('leaves the sandbox disabled by default and fails closed without a baseRootfs', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    const echoSandbox = async () => {
      expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'sandbox-config')).status).toBe(200);
      const stopped = await waitForAssistantStop(runtime.baseUrl, session.id);
      return JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    };

    // No _fe_sandbox* config at all: worker request.sandbox = { enabled: false }.
    expect(await echoSandbox()).toEqual({ enabled: false });

    // Enabled without a provisioned baseRootfs: fail closed (still disabled),
    // so the run continues unsandboxed instead of throwing inside the worker.
    await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _fe_sandboxEnabled: true }),
    });
    expect(await echoSandbox()).toEqual({ enabled: false });
  });

  test('forwards enabled _fe_sandbox config to the worker as a tokimo request', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _fe_sandboxEnabled: true,
        _fe_sandboxBaseRootfs: '/srv/haocode-sandbox/base',
        _fe_sandboxNetwork: 'blocked',
        _fe_sandboxMemoryMb: 8192,
        _fe_sandboxCpuCount: 8,
      }),
    });

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'sandbox-config')).status).toBe(200);
    const stopped = await waitForAssistantStop(runtime.baseUrl, session.id);
    const sandbox = JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    expect(sandbox).toEqual({
      enabled: true,
      provider: 'tokimo',
      baseRootfs: '/srv/haocode-sandbox/base',
      network: 'blocked',
      memoryMb: 8192,
      cpuCount: 8,
    });
  });

  test('normalizes invalid sandbox network to blocked and applies default resource sizes', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _fe_sandboxEnabled: true,
        _fe_sandboxBaseRootfs: '/srv/base',
        _fe_sandboxNetwork: 'wide-open',
      }),
    });

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'sandbox-config')).status).toBe(200);
    const stopped = await waitForAssistantStop(runtime.baseUrl, session.id);
    const sandbox = JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    expect(sandbox.network).toBe('blocked');
    expect(sandbox.memoryMb).toBe(4096);
    expect(sandbox.cpuCount).toBe(4);
  });

  test('passes allow-all sandbox network through unchanged', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    await fetch(`${runtime.baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _fe_sandboxEnabled: true,
        _fe_sandboxBaseRootfs: '/srv/base',
        _fe_sandboxNetwork: 'allow-all',
      }),
    });

    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'sandbox-config')).status).toBe(200);
    const stopped = await waitForAssistantStop(runtime.baseUrl, session.id);
    const sandbox = JSON.parse(stopped.at(-1).parts.find((part) => part.type === 'text').text);
    expect(sandbox.network).toBe('allow-all');
  });

  test('reports sandbox status and rejects prepare when the installer is unavailable', async () => {
    const runtime = await createRuntime();
    // createRuntime does not pass autoloadPath, so resolveSandboxInstaller
    // returns null and /sandbox/prepare fails closed with a 503 instead of
    // spawning a real PHP install (which has no place in unit tests).
    const status = await fetch(`${runtime.baseUrl}/sandbox/status`).then((r) => r.json());
    expect(status.installerAvailable).toBe(false);
    expect(status.preparing).toBe(false);
    expect(status.supported).toBe(true); // tests run on a real platform
    expect(status.installedRootfs).toBeNull();

    const prepare = await fetch(`${runtime.baseUrl}/sandbox/prepare`, { method: 'POST' });
    expect(prepare.status).toBe(503);
    const body = await prepare.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/installer not available/i);
  });

  test('serves GET /provider with all, connected, and default', async () => {
    const runtime = await createRuntime();
    const before = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    expect(before.all.map((provider) => provider.id)).toEqual([
      'anthropic', 'openai', 'deepseek',
      'openrouter', 'xai', 'groq', 'mistral', 'moonshot', 'zai',
      'qwen', 'together', 'fireworks', 'cerebras', 'huggingface',
      'kimi-coding', 'volcengine', 'minimax', 'qianfan', 'siliconflow',
      'stepfun', 'longcat', 'packycode', 'shengsuanyun',
      'github-copilot',
    ]);
    expect(before.connected).not.toContain('deepseek');
    expect(before.default.deepseek).toBe('deepseek-v4-flash');
    expect(before.all.find((provider) => provider.id === 'deepseek').models['deepseek-v4-flash'].limit).toEqual({
      context: 1_000_000,
      output: 384_000,
    });

    await configureDeepSeek(runtime.baseUrl);
    const after = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    expect(after.connected).toContain('deepseek');
  });

  test('lists the built-in OpenAI-compatible provider presets with default limits', async () => {
    const envNames = [
      'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY',
      'DASHSCOPE_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
      'CEREBRAS_API_KEY', 'HF_TOKEN', 'KIMICODE_API_KEY',
      'VOLCANO_ENGINE_API_KEY', 'MINIMAX_API_KEY', 'QIANFAN_API_KEY',
      'SILICONFLOW_API_KEY', 'STEPFUN_API_KEY', 'LONGCAT_API_KEY',
      'PACKYCODE_API_KEY', 'SHENGSUANYUN_API_KEY',
    ];
    const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) delete process.env[name];
    try {
      const runtime = await createRuntime();
    const expected = {
      openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'], model: 'openrouter/auto' },
      xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', env: ['XAI_API_KEY'], model: 'grok-4' },
      groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], model: 'llama-3.3-70b-versatile' },
      mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'], model: 'mistral-large-latest' },
      moonshot: { name: 'Moonshot AI (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', env: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'], model: 'kimi-k2.7-code' },
      zai: { name: 'Z.AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', env: ['ZAI_API_KEY', 'Z_AI_API_KEY'], model: 'glm-5.1' },
      qwen: { name: 'Qwen (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: ['DASHSCOPE_API_KEY'], model: 'qwen3-coder-plus' },
      together: { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'], model: 'deepseek-ai/DeepSeek-V3.2' },
      fireworks: { name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', env: ['FIREWORKS_API_KEY'], model: 'accounts/fireworks/routers/kimi-k2p5-turbo' },
      cerebras: { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', env: ['CEREBRAS_API_KEY'], model: 'llama-4-scout-17b-16e-instruct' },
      huggingface: { name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', env: ['HF_TOKEN'], model: 'deepseek-ai/DeepSeek-V3.2' },
      volcengine: { name: '火山引擎 Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', env: ['VOLCANO_ENGINE_API_KEY'], model: 'ark-code-latest' },
      minimax: { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', env: ['MINIMAX_API_KEY'], model: 'MiniMax-M3' },
      qianfan: { name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2/coding', env: ['QIANFAN_API_KEY'], model: 'qianfan-code-latest' },
      siliconflow: { name: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', env: ['SILICONFLOW_API_KEY'], model: 'Pro/MiniMaxAI/MiniMax-M2.7' },
      stepfun: { name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', env: ['STEPFUN_API_KEY'], model: 'step-3.5-flash' },
      longcat: { name: '美团 LongCat', baseUrl: 'https://api.longcat.chat/openai/v1', env: ['LONGCAT_API_KEY'], model: 'LongCat-2.0' },
      packycode: { name: 'PackyCode', baseUrl: 'https://www.packyapi.com/v1', env: ['PACKYCODE_API_KEY'], model: 'claude-sonnet-5' },
      shengsuanyun: { name: '胜算云', baseUrl: 'https://router.shengsuanyun.com/api/v1', env: ['SHENGSUANYUN_API_KEY'], model: 'anthropic/claude-sonnet-5' },
    };

    const configProviders = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    const listed = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    const auth = await fetch(`${runtime.baseUrl}/provider/auth`).then((response) => response.json());
    for (const [id, preset] of Object.entries(expected)) {
      const entry = configProviders.providers.find((provider) => provider.id === id);
      expect(entry).toMatchObject({
        id,
        name: preset.name,
        source: 'custom',
        env: preset.env,
        options: { baseURL: preset.baseUrl, _fe_providerType: 'openai_chat' },
      });
      // The models.dev fixture has no entries for these presets, so the
      // HaoCode defaults apply.
      expect(entry.models[preset.model].limit).toEqual({ context: 200_000, output: 16_384 });

      const all = listed.all.find((provider) => provider.id === id);
      expect(all.options.baseURL).toBe(preset.baseUrl);
      expect(listed.connected).not.toContain(id);
      expect(listed.default[id]).toBe(preset.model);

      expect(auth[id]).toEqual([{ type: 'api', label: `${preset.name} API key` }]);
      }

      // Kimi For Coding is the one built-in preset on the Anthropic protocol.
      const kimiCoding = configProviders.providers.find((provider) => provider.id === 'kimi-coding');
      expect(kimiCoding).toMatchObject({
        id: 'kimi-coding',
        name: 'Kimi For Coding',
        source: 'custom',
        env: ['KIMI_API_KEY', 'KIMICODE_API_KEY'],
        options: { baseURL: 'https://api.kimi.com/coding/', _fe_providerType: 'anthropic' },
      });
      expect(kimiCoding.models['kimi-for-coding'].limit).toEqual({ context: 200_000, output: 16_384 });
      expect(listed.connected).not.toContain('kimi-coding');
      expect(listed.default['kimi-coding']).toBe('kimi-for-coding');
      expect(auth['kimi-coding']).toEqual([{ type: 'api', label: 'Kimi For Coding API key' }]);
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('resolves credentials through ordered environment variable aliases', async () => {
    const savedEnv = {
      MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
      KIMI_API_KEY: process.env.KIMI_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      Z_AI_API_KEY: process.env.Z_AI_API_KEY,
    };
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    try {
      const runtime = await createRuntime();
      // Second alias only: the provider still counts as connected, the source
      // route sees a credential, and the worker receives the alias value.
      process.env.KIMI_API_KEY = 'kimi-env-key';
      const listed = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
      expect(listed.connected).toContain('moonshot');
      expect(listed.connected).not.toContain('zai');
      const source = await fetch(`${runtime.baseUrl}/provider/moonshot/source`).then((response) => response.json());
      expect(source.sources.auth.exists).toBe(true);

      const probe = await runProviderProbe(runtime, 'moonshot', 'kimi-k2.7-code');
      expect(probe).toEqual({ apiKey: 'kimi-env-key', oauthBearer: null });

      // First alias wins when several are set.
      process.env.Z_AI_API_KEY = 'zai-second';
      process.env.ZAI_API_KEY = 'zai-first';
      const zaiProbe = await runProviderProbe(runtime, 'zai', 'glm-5.1');
      expect(zaiProbe).toEqual({ apiKey: 'zai-first', oauthBearer: null });
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('creates, authenticates, overrides, and deletes a custom provider', async () => {
    const runtime = await createRuntime();
    const created = await fetch(`${runtime.baseUrl}/provider/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Gateway',
        providerType: 'openai_chat',
        baseUrl: 'https://acme.example.test/v1',
        models: ['acme-pro'],
        contextWindow: 123_456,
        maxTokens: 8_192,
        apiKey: 'sk-acme',
      }),
    });
    expect(created.status).toBe(200);
    const entry = await created.json();
    expect(entry).toMatchObject({
      id: 'acme-gateway',
      name: 'Acme Gateway',
      source: 'api',
      options: { baseURL: 'https://acme.example.test/v1', _fe_providerType: 'openai_chat' },
    });
    expect(entry.models['acme-pro'].limit).toEqual({ context: 123_456, output: 8_192 });

    const listed = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    expect(listed.all.map((provider) => provider.id)).toContain('acme-gateway');
    expect(listed.connected).toContain('acme-gateway');
    expect(listed.default['acme-gateway']).toBe('acme-pro');

    const configProviders = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    expect(configProviders.providers.map((provider) => provider.id)).toContain('acme-gateway');

    const settings = await fetch(`${runtime.baseUrl}/provider/acme-gateway/settings`).then((response) => response.json());
    expect(settings).toMatchObject({
      baseUrl: 'https://acme.example.test/v1',
      providerType: 'openai_chat',
      contextWindow: 123_456,
      maxTokens: 8_192,
    });

    const source = await fetch(`${runtime.baseUrl}/provider/acme-gateway/source`).then((response) => response.json());
    expect(source.sources.auth.exists).toBe(true);

    // A PATCH override on the custom id wins over the creation-time limits;
    // deleting the override restores the custom provider defaults.
    const patched = await fetch(`${runtime.baseUrl}/provider/acme-gateway/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextWindow: 64_000 }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ contextWindow: 64_000, maxTokens: 8_192 });
    const overridden = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    expect(overridden.providers.find((provider) => provider.id === 'acme-gateway').models['acme-pro'].limit)
      .toEqual({ context: 64_000, output: 8_192 });
    const reset = await fetch(`${runtime.baseUrl}/provider/acme-gateway/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextWindow: null }),
    });
    expect(await reset.json()).toMatchObject({ contextWindow: 123_456, maxTokens: 8_192 });

    const removed = await fetch(`${runtime.baseUrl}/provider/custom/acme-gateway`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });

    const afterRemoval = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    expect(afterRemoval.all.map((provider) => provider.id)).not.toContain('acme-gateway');
    const state = await runtime.runtime.store.read((current) => current);
    expect(state.customProviders['acme-gateway']).toBeUndefined();
    expect(state.providers['acme-gateway']).toBeUndefined();
    expect((await fetch(`${runtime.baseUrl}/provider/acme-gateway/settings`)).status).toBe(404);
  });

  test('validates custom provider payloads and protects built-in providers', async () => {
    const runtime = await createRuntime();
    const create = (body) => fetch(`${runtime.baseUrl}/provider/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect((await create({ providerType: 'openai_chat', baseUrl: 'https://a.example.test' })).status).toBe(400);
    expect((await create({ name: 'X', providerType: 'bogus', baseUrl: 'https://a.example.test' })).status).toBe(400);
    expect((await create({ name: 'X', providerType: 'openai_chat', baseUrl: 'not-a-url' })).status).toBe(400);
    expect((await create({ name: 'X', providerType: 'openai_chat', baseUrl: 'ftp://a.example.test' })).status).toBe(400);
    expect((await create({ name: 'X', providerType: 'openai_chat', baseUrl: 'https://a.example.test', contextWindow: 'lots' })).status).toBe(400);
    expect((await create({ name: 'X', providerType: 'openai_chat', baseUrl: 'https://a.example.test', maxTokens: -1 })).status).toBe(400);
    expect((await create({ id: 'Bad ID!', name: 'X', providerType: 'openai_chat', baseUrl: 'https://a.example.test' })).status).toBe(400);
    // Slugifying the name or passing an explicit id cannot shadow a built-in.
    expect((await create({ name: 'DeepSeek', providerType: 'openai_chat', baseUrl: 'https://a.example.test' })).status).toBe(409);
    expect((await create({ id: 'anthropic', name: 'X', providerType: 'openai_chat', baseUrl: 'https://a.example.test' })).status).toBe(409);

    const ok = await create({ name: 'Acme', providerType: 'openai', baseUrl: 'https://a.example.test' });
    expect(ok.status).toBe(200);
    expect((await create({ name: 'Acme', providerType: 'openai', baseUrl: 'https://a.example.test' })).status).toBe(409);

    expect((await fetch(`${runtime.baseUrl}/provider/custom/deepseek`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${runtime.baseUrl}/provider/custom/nope`, { method: 'DELETE' })).status).toBe(404);
  });

  test('overrides and resets model limits through provider settings PATCH', async () => {
    const runtime = await createRuntime();
    const patch = (body) => fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const overridden = await patch({ contextWindow: 500_000, maxTokens: 4_096 });
    expect(overridden.status).toBe(200);
    expect(await overridden.json()).toMatchObject({ contextWindow: 500_000, maxTokens: 4_096 });

    const settings = await fetch(`${runtime.baseUrl}/provider/deepseek/settings`).then((response) => response.json());
    expect(settings).toMatchObject({ contextWindow: 500_000, maxTokens: 4_096 });

    // The saved override beats the models.dev catalog (1_000_000/384_000).
    const providers = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    expect(providers.providers.find((provider) => provider.id === 'deepseek').models['deepseek-v4-flash'].limit)
      .toEqual({ context: 500_000, output: 4_096 });

    expect((await patch({ contextWindow: -10 })).status).toBe(400);
    expect((await patch({ maxTokens: 'big' })).status).toBe(400);

    // null and 0 delete the override; catalog resolution takes over again.
    const reset = await patch({ contextWindow: null, maxTokens: 0 });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ contextWindow: null, maxTokens: null });
    const restored = await fetch(`${runtime.baseUrl}/config/providers`).then((response) => response.json());
    expect(restored.providers.find((provider) => provider.id === 'deepseek').models['deepseek-v4-flash'].limit)
      .toEqual({ context: 1_000_000, output: 384_000 });
  });

  test('sends custom provider settings and limit overrides to the worker', async () => {
    const runtime = await createRuntime();
    const created = await fetch(`${runtime.baseUrl}/provider/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme',
        providerType: 'openai_chat',
        baseUrl: 'https://acme.example.test/v1',
        models: ['acme-pro'],
        contextWindow: 77_777,
        apiKey: 'sk-acme',
      }),
    });
    expect(created.status).toBe(200);

    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'limits', {
      model: { providerID: 'acme', modelID: 'acme-pro' },
    });
    expect(response.status).toBe(200);
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const limit = JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);
    expect(limit).toEqual({ context: 77_777, output: 16_384 });
  });

  // --- OAuth login flows ---------------------------------------------------

  const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  // Fake fetch injected into the compatibility server for OAuth token
  // endpoints; records every call so tests can assert the request shape.
  const createFetchStub = (handler) => {
    const calls = [];
    const fetchStub = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    };
    fetchStub.calls = calls;
    fetchStub.formCalls = () => calls.map((call) => ({
      url: call.url,
      params: Object.fromEntries(new URLSearchParams(call.init.body)),
    }));
    return fetchStub;
  };

  const fakeJwt = (payload) => {
    const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${segment({ alg: 'none' })}.${segment(payload)}.signature`;
  };

  const storeOAuth = (runtime, providerId, oauth) => runtime.runtime.store.mutate((state) => {
    state.providers[providerId] = { ...(state.providers[providerId] ?? {}), oauth };
  });

  const readOAuth = (runtime, providerId) => runtime.runtime.store
    .read((state) => state.providers[providerId]?.oauth ?? null);

  const oauthAuthorize = (baseUrl, providerId) => fetch(`${baseUrl}/provider/${providerId}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 0 }),
  });

  const oauthCallback = (baseUrl, providerId, body = { method: 0 }) => fetch(`${baseUrl}/provider/${providerId}/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const runProviderProbe = async (runtime, providerId, modelId, promptText = 'provider-probe') => {
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, promptText, {
      model: { providerID: providerId, modelID: modelId },
    });
    expect(response.status).toBe(200);
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    return JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);
  };

  test('lists oauth auth methods for Anthropic, OpenAI, and GitHub Copilot only', async () => {
    const runtime = await createRuntime();
    const methods = await fetch(`${runtime.baseUrl}/provider/auth`).then((response) => response.json());
    expect(methods.anthropic).toEqual([
      { type: 'api', label: 'Anthropic API key' },
      { type: 'oauth', label: 'Claude Pro/Max（浏览器授权）' },
    ]);
    expect(methods.openai).toEqual([
      { type: 'api', label: 'OpenAI API key' },
      { type: 'oauth', label: 'ChatGPT Pro/Plus（浏览器授权）' },
    ]);
    expect(methods['github-copilot']).toEqual([
      { type: 'api', label: 'GitHub Copilot API key' },
      { type: 'oauth', label: 'GitHub 账号（设备码授权）' },
    ]);
    expect(methods.deepseek).toEqual([{ type: 'api', label: 'DeepSeek API key' }]);

    const created = await fetch(`${runtime.baseUrl}/provider/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', providerType: 'openai_chat', baseUrl: 'https://acme.example.test/v1' }),
    });
    expect(created.status).toBe(200);
    const after = await fetch(`${runtime.baseUrl}/provider/auth`).then((response) => response.json());
    expect(after.acme).toEqual([{ type: 'api', label: 'Acme API key' }]);

    const unsupported = await oauthAuthorize(runtime.baseUrl, 'deepseek');
    expect(unsupported.status).toBe(400);
  });

  test('completes the Anthropic paste-code flow and stores tokens without leaking them', async () => {
    const fetchStub = createFetchStub(async (url) => {
      expect(url).toBe('https://console.anthropic.com/v1/oauth/token');
      return jsonResponse({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600 });
    });
    const runtime = await createRuntime({ fetchImpl: fetchStub });

    const authorize = await oauthAuthorize(runtime.baseUrl, 'anthropic');
    expect(authorize.status).toBe(200);
    const authorization = await authorize.json();
    expect(authorization.method).toBe('code');
    expect(authorization.instructions).toBeTruthy();
    const url = new URL(authorization.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.anthropic.com/oauth/code/callback');
    expect(url.searchParams.get('scope')).toBe('org:create_api_key user:profile user:inference');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    // A wrong pasted state is rejected before any token request.
    const wrongState = await oauthCallback(runtime.baseUrl, 'anthropic', { method: 0, code: 'code_abc#bogus-state' });
    expect(wrongState.status).toBe(400);
    expect(fetchStub.calls).toHaveLength(0);

    // "<code>#<state>" paste succeeds.
    const callback = await oauthCallback(runtime.baseUrl, 'anthropic', { method: 0, code: `code_abc#${state}` });
    expect(callback.status).toBe(200);
    expect(await callback.json()).toBe(true);
    const [call] = fetchStub.formCalls();
    expect(call.params).toMatchObject({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'code_abc',
      state,
      redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
    });
    expect(call.params.code_verifier).toBeTruthy();

    const stored = await readOAuth(runtime, 'anthropic');
    expect(stored.access).toBe('at_1');
    expect(stored.refresh).toBe('rt_1');
    expect(stored.expires).toBeGreaterThan(Date.now());
    // Secrets never reach API responses.
    const settings = await fetch(`${runtime.baseUrl}/provider/anthropic/settings`).then((response) => response.json());
    expect(JSON.stringify(settings)).not.toContain('at_1');
    expect(JSON.stringify(settings)).not.toContain('rt_1');

    // A bare code (no "#state") uses the pending flow's state.
    const secondAuthorize = await oauthAuthorize(runtime.baseUrl, 'anthropic');
    expect(secondAuthorize.status).toBe(200);
    const bare = await oauthCallback(runtime.baseUrl, 'anthropic', { method: 0, code: 'code_bare' });
    expect(bare.status).toBe(200);
    expect(fetchStub.formCalls()[1].params.code).toBe('code_bare');
  });

  test('rejects Anthropic callbacks without a pending flow or code', async () => {
    const fetchStub = createFetchStub(async () => jsonResponse({ access_token: 'at', refresh_token: 'rt' }));
    const runtime = await createRuntime({ fetchImpl: fetchStub });
    const noFlow = await oauthCallback(runtime.baseUrl, 'anthropic', { method: 0, code: 'code_abc#state' });
    expect(noFlow.status).toBe(400);
    expect(await oauthAuthorize(runtime.baseUrl, 'anthropic')).toBeTruthy();
    const noCode = await oauthCallback(runtime.baseUrl, 'anthropic', { method: 0 });
    expect(noCode.status).toBe(400);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test('completes the OpenAI browser flow through the localhost callback listener', async () => {
    const fetchStub = createFetchStub(async (url) => {
      expect(url).toBe('https://auth.openai.com/oauth/token');
      return jsonResponse({
        access_token: 'oat_1',
        refresh_token: 'ort_1',
        expires_in: 3600,
        id_token: fakeJwt({ chatgpt_account_id: 'acct_123' }),
      });
    });
    // Port 0 binds an ephemeral listener port for the test.
    const runtime = await createRuntime({ fetchImpl: fetchStub, oauthCallbackPorts: [0] });

    const authorize = await oauthAuthorize(runtime.baseUrl, 'openai');
    expect(authorize.status).toBe(200);
    const authorization = await authorize.json();
    expect(authorization.method).toBe('auto');
    expect(authorization.instructions).toBeTruthy();
    const url = new URL(authorization.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('originator')).toBe('opencode');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    const redirectUri = url.searchParams.get('redirect_uri');
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);

    // Simulate the browser being redirected back with the authorization code.
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', 'ocode_1');
    redirect.searchParams.set('state', state);
    const landing = await fetch(redirect);
    expect(landing.status).toBe(200);

    const callback = await oauthCallback(runtime.baseUrl, 'openai');
    expect(callback.status).toBe(200);
    expect(await callback.json()).toBe(true);
    const [call] = fetchStub.formCalls();
    expect(call.params).toMatchObject({
      grant_type: 'authorization_code',
      code: 'ocode_1',
      redirect_uri: redirectUri,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
    expect(call.params.code_verifier).toBeTruthy();

    const stored = await readOAuth(runtime, 'openai');
    expect(stored).toMatchObject({ access: 'oat_1', refresh: 'ort_1', accountId: 'acct_123' });
    expect(stored.expires).toBeGreaterThan(Date.now());
  });

  test('rejects the OpenAI callback on state mismatch and on timeout', async () => {
    const fetchStub = createFetchStub(async () => jsonResponse({ access_token: 'oat', refresh_token: 'ort' }));
    const runtime = await createRuntime({ fetchImpl: fetchStub, oauthCallbackPorts: [0] });

    const authorization = await (await oauthAuthorize(runtime.baseUrl, 'openai')).json();
    const redirect = new URL(new URL(authorization.url).searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'ocode_1');
    redirect.searchParams.set('state', 'forged-state');
    await fetch(redirect);
    const mismatch = await oauthCallback(runtime.baseUrl, 'openai');
    expect(mismatch.status).toBe(400);
    expect(fetchStub.calls).toHaveLength(0);

    await runtime.runtime.stop();
    runtimes.splice(runtimes.indexOf(runtime.runtime), 1);

    const timedRuntime = await createRuntime({
      fetchImpl: fetchStub,
      oauthCallbackPorts: [0],
      oauthCallbackTimeoutMs: 100,
    });
    expect((await oauthAuthorize(timedRuntime.baseUrl, 'openai')).status).toBe(200);
    const timedOut = await oauthCallback(timedRuntime.baseUrl, 'openai');
    expect(timedOut.status).toBe(400);
    expect((await timedOut.json()).error).toMatch(/timed out/i);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test('refreshes a near-expiry oauth token before sending it to the worker as a bearer credential', async () => {
    const fetchStub = createFetchStub(async (url) => {
      expect(url).toBe('https://console.anthropic.com/v1/oauth/token');
      return jsonResponse({ access_token: 'at_fresh', refresh_token: 'rt_fresh', expires_in: 7200 });
    });
    const runtime = await createRuntime({ fetchImpl: fetchStub });
    // Expires in 60s: inside the 5-minute refresh skew.
    await storeOAuth(runtime, 'anthropic', { access: 'at_old', refresh: 'rt_old', expires: Date.now() + 60_000 });

    const probe = await runProviderProbe(runtime, 'anthropic', 'claude-sonnet-4-20250514');
    expect(probe).toEqual({ apiKey: 'at_fresh', oauthBearer: true });

    const refreshCalls = fetchStub.formCalls().filter((call) => call.params.grant_type === 'refresh_token');
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].params).toMatchObject({
      refresh_token: 'rt_old',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    // The refresh is written back to persisted state.
    const stored = await readOAuth(runtime, 'anthropic');
    expect(stored).toMatchObject({ access: 'at_fresh', refresh: 'rt_fresh' });
  });

  test('falls back to the saved api key when the oauth refresh fails', async () => {
    const fetchStub = createFetchStub(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const runtime = await createRuntime({ fetchImpl: fetchStub });
    await storeOAuth(runtime, 'anthropic', { access: 'at_old', refresh: 'rt_old', expires: Date.now() + 60_000 });
    const saved = await fetch(`${runtime.baseUrl}/auth/anthropic`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: 'sk-saved' }),
    });
    expect(await saved.json()).toBe(true);

    const probe = await runProviderProbe(runtime, 'anthropic', 'claude-sonnet-4-20250514');
    expect(probe).toEqual({ apiKey: 'sk-saved', oauthBearer: null });
    expect(fetchStub.calls.length).toBeGreaterThan(0);
  });

  test('uses a fresh oauth access token without refreshing and keeps it off the api-key path', async () => {
    const fetchStub = createFetchStub(async () => {
      throw new Error('token endpoint must not be called for a fresh token');
    });
    const runtime = await createRuntime({ fetchImpl: fetchStub });
    await storeOAuth(runtime, 'openai', { access: 'oat_live', refresh: 'ort_live', expires: Date.now() + 3_600_000 });

    const probe = await runProviderProbe(runtime, 'openai', 'gpt-5');
    expect(probe).toEqual({ apiKey: 'oat_live', oauthBearer: null });
    expect(fetchStub.calls).toHaveLength(0);

    const listed = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
    expect(listed.connected).toContain('openai');
    const source = await fetch(`${runtime.baseUrl}/provider/openai/source`).then((response) => response.json());
    expect(source.sources.auth.exists).toBe(true);
  });

  test('clears stored oauth tokens when auth is deleted', async () => {
    const runtime = await createRuntime();
    await storeOAuth(runtime, 'anthropic', { access: 'at_1', refresh: 'rt_1', expires: Date.now() + 3_600_000 });
    await fetch(`${runtime.baseUrl}/auth/anthropic`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: 'sk-saved' }),
    });
    const removed = await fetch(`${runtime.baseUrl}/auth/anthropic`, { method: 'DELETE' });
    expect(await removed.json()).toBe(true);
    const entry = await runtime.runtime.store.read((state) => state.providers.anthropic ?? {});
    expect(entry.apiKey).toBeUndefined();
    expect(entry.oauth).toBeUndefined();
  });

  // --- GitHub Copilot dual-stage device flow --------------------------------

  const COPILOT_ENV_NAMES = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
  const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code';
  const COPILOT_POLL_URL = 'https://github.com/login/oauth/access_token';
  const COPILOT_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
  const COPILOT_EXPECTED_HEADERS = {
    'Editor-Version': 'vscode/1.96.2',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'User-Agent': 'GitHubCopilotChat/0.26.7',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Organization': 'github-copilot',
  };

  // Run a Copilot test with the GitHub-token env aliases cleared (the real
  // environment may define GH_TOKEN/GITHUB_TOKEN), optionally setting some.
  const withCopilotEnv = async (env, run) => {
    const savedEnv = Object.fromEntries(COPILOT_ENV_NAMES.map((name) => [name, process.env[name]]));
    for (const name of COPILOT_ENV_NAMES) delete process.env[name];
    Object.assign(process.env, env);
    try {
      return await run();
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  test('completes the GitHub Copilot device-code flow and stores the exchanged token', async () => {
    const sleeps = [];
    const sleepStub = async (ms) => { sleeps.push(ms); };
    const pollResponses = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'gh_oauth_1' },
    ];
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchStub = createFetchStub(async (url) => {
      if (url === COPILOT_DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: 'dc_1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === COPILOT_POLL_URL) return jsonResponse(pollResponses.shift() ?? { access_token: 'gh_oauth_1' });
      if (url === COPILOT_EXCHANGE_URL) return jsonResponse({ token: 'ct_live_1', expires_at: expiresAt });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const runtime = await createRuntime({ fetchImpl: fetchStub, sleepImpl: sleepStub });

    const authorize = await oauthAuthorize(runtime.baseUrl, 'github-copilot');
    expect(authorize.status).toBe(200);
    const authorization = await authorize.json();
    expect(authorization).toEqual({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code: ABCD-1234',
    });
    const [deviceCall] = fetchStub.formCalls();
    expect(deviceCall.url).toBe(COPILOT_DEVICE_CODE_URL);
    expect(deviceCall.params).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });

    const callback = await oauthCallback(runtime.baseUrl, 'github-copilot');
    expect(callback.status).toBe(200);
    expect(await callback.json()).toBe(true);

    // Polling cadence: device interval (1s floor), then +2s after slow_down.
    expect(sleeps).toEqual([1000, 3000]);
    const pollCalls = fetchStub.formCalls().filter((call) => call.url === COPILOT_POLL_URL);
    expect(pollCalls).toHaveLength(3);
    expect(pollCalls[0].params).toEqual({
      client_id: 'Iv1.b507a08c87ecfe98',
      device_code: 'dc_1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    // Stage two: the GitHub token is exchanged for a Copilot API token.
    const exchangeCall = fetchStub.calls.find((call) => call.url === COPILOT_EXCHANGE_URL);
    expect(exchangeCall.init.method ?? 'GET').toBe('GET');
    expect(exchangeCall.init.headers).toMatchObject({
      Authorization: 'Bearer gh_oauth_1',
      Accept: 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'X-Github-Api-Version': '2025-04-01',
    });

    const stored = await readOAuth(runtime, 'github-copilot');
    expect(stored).toEqual({ access: 'ct_live_1', refresh: 'gh_oauth_1', expires: expiresAt * 1000 });

    // Secrets never reach API responses.
    const settings = await fetch(`${runtime.baseUrl}/provider/github-copilot/settings`).then((response) => response.json());
    expect(JSON.stringify(settings)).not.toContain('ct_live_1');
    expect(JSON.stringify(settings)).not.toContain('gh_oauth_1');
  });

  test('fails the GitHub device flow on expired_token and access_denied', async () => {
    let pollPayload = { error: 'expired_token' };
    const fetchStub = createFetchStub(async (url) => {
      if (url === COPILOT_DEVICE_CODE_URL) {
        return jsonResponse({ device_code: 'dc_1', user_code: 'CODE', verification_uri: 'https://github.com/login/device', interval: 1 });
      }
      if (url === COPILOT_POLL_URL) return jsonResponse(pollPayload);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const runtime = await createRuntime({ fetchImpl: fetchStub, sleepImpl: async () => {} });

    expect((await oauthAuthorize(runtime.baseUrl, 'github-copilot')).status).toBe(200);
    const expired = await oauthCallback(runtime.baseUrl, 'github-copilot');
    expect(expired.status).toBe(400);
    expect((await expired.json()).error).toMatch(/expired/i);

    pollPayload = { error: 'access_denied' };
    expect((await oauthAuthorize(runtime.baseUrl, 'github-copilot')).status).toBe(200);
    const denied = await oauthCallback(runtime.baseUrl, 'github-copilot');
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toMatch(/denied/i);

    // The stage-two exchange is never attempted.
    expect(fetchStub.calls.filter((call) => call.url === COPILOT_EXCHANGE_URL)).toHaveLength(0);
    expect(await readOAuth(runtime, 'github-copilot')).toBeNull();
  });

  test('reuses the cached Copilot token, re-exchanges near expiry, and injects the API headers', async () => {
    await withCopilotEnv({}, async () => {
      const exchangeCalls = [];
      let exchangePayload = null;
      const fetchStub = createFetchStub(async (url) => {
        if (url === COPILOT_EXCHANGE_URL && exchangePayload) return jsonResponse(exchangePayload);
        throw new Error(`unexpected fetch: ${url}`);
      });
      const runtime = await createRuntime({ fetchImpl: fetchStub });

      // Fresh cached token: no exchange, headers attached to the worker request.
      await storeOAuth(runtime, 'github-copilot', { access: 'ct_cached', refresh: 'gh_cached', expires: Date.now() + 3_600_000 });
      const cached = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(cached).toEqual({ apiKey: 'ct_cached', headers: COPILOT_EXPECTED_HEADERS });
      expect(fetchStub.calls).toHaveLength(0);

      // Near-expiry token: re-exchange with the stored GitHub token.
      await storeOAuth(runtime, 'github-copilot', { access: 'ct_cached', refresh: 'gh_cached', expires: Date.now() + 60_000 });
      exchangePayload = { token: 'ct_fresh', expires_at: Math.floor(Date.now() / 1000) + 3600 };
      const refreshed = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(refreshed).toEqual({ apiKey: 'ct_fresh', headers: COPILOT_EXPECTED_HEADERS });
      expect(fetchStub.calls).toHaveLength(1);
      expect(fetchStub.calls[0].init.headers.Authorization).toBe('Bearer gh_cached');
      exchangeCalls.push(fetchStub.calls[0]);
      expect(await readOAuth(runtime, 'github-copilot')).toMatchObject({ access: 'ct_fresh', refresh: 'gh_cached' });

      // The re-exchange is cached: the next run makes no further requests.
      const after = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(after.apiKey).toBe('ct_fresh');
      expect(fetchStub.calls).toHaveLength(1);
    });
  });

  test('exchanges an environment GitHub token for a Copilot token and caches it', async () => {
    await withCopilotEnv({ GITHUB_TOKEN: 'gh_secondary', GH_TOKEN: 'gh_env_1' }, async () => {
      const fetchStub = createFetchStub(async (url) => {
        if (url === COPILOT_EXCHANGE_URL) {
          return jsonResponse({ token: 'ct_env', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const runtime = await createRuntime({ fetchImpl: fetchStub });

      const probe = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(probe).toEqual({ apiKey: 'ct_env', headers: COPILOT_EXPECTED_HEADERS });
      expect(fetchStub.calls).toHaveLength(1);
      // Ordered env aliases: GH_TOKEN wins over GITHUB_TOKEN.
      expect(fetchStub.calls[0].init.headers.Authorization).toBe('Bearer gh_env_1');

      // The exchange is cached under state.oauth with the env token as refresh.
      expect(await readOAuth(runtime, 'github-copilot')).toMatchObject({ access: 'ct_env', refresh: 'gh_env_1' });
      const listed = await fetch(`${runtime.baseUrl}/provider`).then((response) => response.json());
      expect(listed.connected).toContain('github-copilot');

      // Cache hit: a second run performs no further exchange.
      const again = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(again.apiKey).toBe('ct_env');
      expect(fetchStub.calls).toHaveLength(1);
    });
  });

  test('exchanges a saved api key (GitHub token) when no oauth record exists', async () => {
    await withCopilotEnv({}, async () => {
      const fetchStub = createFetchStub(async (url) => {
        if (url === COPILOT_EXCHANGE_URL) {
          return jsonResponse({ token: 'ct_saved', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const runtime = await createRuntime({ fetchImpl: fetchStub });
      const saved = await fetch(`${runtime.baseUrl}/auth/github-copilot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api', key: 'gh_saved_1' }),
      });
      expect(await saved.json()).toBe(true);

      const probe = await runProviderProbe(runtime, 'github-copilot', 'gpt-4o', 'provider-headers-probe');
      expect(probe.apiKey).toBe('ct_saved');
      expect(fetchStub.calls).toHaveLength(1);
      expect(fetchStub.calls[0].init.headers.Authorization).toBe('Bearer gh_saved_1');
      expect(await readOAuth(runtime, 'github-copilot')).toMatchObject({ access: 'ct_saved', refresh: 'gh_saved_1' });
    });
  });

  test('supports the client id override and clears Copilot credentials on DELETE', async () => {
    const savedClientId = process.env.HAOWORK_OAUTH_GITHUB_COPILOT_CLIENT_ID;
    process.env.HAOWORK_OAUTH_GITHUB_COPILOT_CLIENT_ID = 'client_override';
    try {
      const fetchStub = createFetchStub(async (url) => {
        if (url === COPILOT_DEVICE_CODE_URL) {
          return jsonResponse({ device_code: 'dc_1', user_code: 'CODE', verification_uri: 'https://github.com/login/device', interval: 1 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const runtime = await createRuntime({ fetchImpl: fetchStub, sleepImpl: async () => {} });
      expect((await oauthAuthorize(runtime.baseUrl, 'github-copilot')).status).toBe(200);
      expect(fetchStub.formCalls()[0].params.client_id).toBe('client_override');

      // DELETE cancels the pending device flow and removes stored credentials.
      await storeOAuth(runtime, 'github-copilot', { access: 'ct_1', refresh: 'gh_1', expires: Date.now() + 3_600_000 });
      const removed = await fetch(`${runtime.baseUrl}/auth/github-copilot`, { method: 'DELETE' });
      expect(await removed.json()).toBe(true);
      expect(await readOAuth(runtime, 'github-copilot')).toBeNull();
      const callback = await oauthCallback(runtime.baseUrl, 'github-copilot');
      expect(callback.status).toBe(400);
    } finally {
      if (savedClientId === undefined) delete process.env.HAOWORK_OAUTH_GITHUB_COPILOT_CLIENT_ID;
      else process.env.HAOWORK_OAUTH_GITHUB_COPILOT_CLIENT_ID = savedClientId;
    }
  });

  test('forwards image attachments natively and keeps data URIs out of the prompt', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=';
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe describe', {
      parts: [
        { type: 'text', text: 'images-probe describe' },
        { type: 'file', mime: 'image/png', url: dataUri, filename: 'shot.png' },
        { type: 'file', mime: 'application/pdf', url: 'https://files.example.test/doc.pdf', filename: 'doc.pdf' },
      ],
    });
    expect(response.status).toBe(200);
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    const payload = JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);
    expect(payload.images).toEqual([dataUri]);
    expect(payload.prompt).toContain('[Attached image shot.png]');
    expect(payload.prompt).not.toContain('base64');
    expect(payload.prompt).toContain('[Attached file doc.pdf: https://files.example.test/doc.pdf]');
  });

  test('validates and persists imagePolicy and imageVlmModel through provider settings PATCH', async () => {
    const runtime = await createRuntime();
    const patch = (body) => fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const get = () => fetch(`${runtime.baseUrl}/provider/deepseek/settings`).then((response) => response.json());

    expect(await get()).toMatchObject({ imagePolicy: 'native', imageVlmModel: null });

    expect((await patch({ imagePolicy: 'bogus' })).status).toBe(400);
    expect((await patch({ imageVlmModel: 42 })).status).toBe(400);
    // vlm requires a vision model id.
    expect((await patch({ imagePolicy: 'vlm' })).status).toBe(400);

    const vlm = await patch({ imagePolicy: 'vlm', imageVlmModel: 'gpt-4o' });
    expect(vlm.status).toBe(200);
    expect(await vlm.json()).toMatchObject({ imagePolicy: 'vlm', imageVlmModel: 'gpt-4o' });
    expect(await get()).toMatchObject({ imagePolicy: 'vlm', imageVlmModel: 'gpt-4o' });

    // Clearing the model while the policy stays vlm is rejected.
    expect((await patch({ imageVlmModel: null })).status).toBe(400);

    const reset = await patch({ imagePolicy: 'native', imageVlmModel: null });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ imagePolicy: 'native', imageVlmModel: null });
    expect(await get()).toMatchObject({ imagePolicy: 'native', imageVlmModel: null });

    // Non-vlm policies persist without a model.
    expect((await patch({ imagePolicy: 'ocr' })).status).toBe(200);
    expect(await get()).toMatchObject({ imagePolicy: 'ocr', imageVlmModel: null });
  });

  test('validates and persists per-model image policy overrides through provider settings PATCH', async () => {
    const runtime = await createRuntime();
    const patch = (body) => fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const get = () => fetch(`${runtime.baseUrl}/provider/deepseek/settings`).then((response) => response.json());

    expect(await get()).toMatchObject({ modelImagePolicies: {} });

    expect((await patch({ modelImagePolicy: 'ocr' })).status).toBe(400);
    expect((await patch({ modelImagePolicy: { policy: 'ocr' } })).status).toBe(400);
    expect((await patch({ modelImagePolicy: { model: '  ', policy: 'ocr' } })).status).toBe(400);
    expect((await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: 'bogus' } })).status).toBe(400);
    expect((await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: 7 } })).status).toBe(400);
    // A vlm override requires the provider-level vision model id.
    expect((await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: 'vlm' } })).status).toBe(400);
    expect(await get()).toMatchObject({ modelImagePolicies: {} });

    const set = await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: 'ocr' } });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ modelImagePolicies: { 'deepseek-chat': 'ocr' } });
    expect(await get()).toMatchObject({ modelImagePolicies: { 'deepseek-chat': 'ocr' } });

    // Setting another model accumulates; clearing one keeps the rest.
    expect((await patch({ modelImagePolicy: { model: 'deepseek-v4-flash', policy: 'drop' } })).status).toBe(200);
    const cleared = await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: null } });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ modelImagePolicies: { 'deepseek-v4-flash': 'drop' } });

    // Clearing the last override removes the stored map.
    expect((await patch({ modelImagePolicy: { model: 'deepseek-v4-flash', policy: null } })).status).toBe(200);
    expect(await get()).toMatchObject({ modelImagePolicies: {} });

    // A vlm override persists once the vision model is configured.
    expect((await patch({ imageVlmModel: 'gpt-4o', modelImagePolicy: { model: 'deepseek-chat', policy: 'vlm' } })).status).toBe(200);
    expect(await get()).toMatchObject({ imageVlmModel: 'gpt-4o', modelImagePolicies: { 'deepseek-chat': 'vlm' } });
  });

  const readImagesProbePayload = async (runtime, sessionId) => {
    const records = await waitForAssistantStop(runtime.baseUrl, sessionId);
    return JSON.parse(records
      .find((record) => record.info.role === 'assistant')
      .parts.find((part) => part.type === 'text').text);
  };

  test('per-model image policy overrides the provider default and falls back when cleared', async () => {
    const calls = [];
    const runtime = await createRuntime({
      imageConverters: {
        ocr: async (dataUri) => { calls.push(dataUri); return '覆盖模型文字'; },
        caption: async () => { throw new Error('caption should not run'); },
        vlm: async () => { throw new Error('vlm should not run'); },
      },
    });
    await configureDeepSeek(runtime.baseUrl);
    const patch = (body) => fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=';
    const imageParts = (text) => [
      { type: 'text', text },
      { type: 'file', mime: 'image/png', url: dataUri, filename: 'shot.png' },
    ];

    // Provider default is native; the per-model ocr override wins for that model.
    expect((await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: 'ocr' } })).status).toBe(200);
    const overrideSession = await createSession(runtime);
    const overrideResponse = await prompt(runtime.baseUrl, runtime.project, overrideSession.id, 'images-probe override', {
      model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      parts: imageParts('images-probe override'),
    });
    expect(overrideResponse.status).toBe(200);
    const overridePayload = await readImagesProbePayload(runtime, overrideSession.id);
    expect(calls).toEqual([dataUri]);
    expect(overridePayload.images).toBeNull();
    expect(overridePayload.prompt).toContain('[图片 shot.png: 覆盖模型文字]');

    // Other models still follow the provider default (native).
    const defaultSession = await createSession(runtime);
    const defaultResponse = await prompt(runtime.baseUrl, runtime.project, defaultSession.id, 'images-probe default', {
      parts: imageParts('images-probe default'),
    });
    expect(defaultResponse.status).toBe(200);
    const defaultPayload = await readImagesProbePayload(runtime, defaultSession.id);
    expect(calls).toEqual([dataUri]);
    expect(defaultPayload.images).toEqual([dataUri]);

    // Clearing the override falls back to the provider default again.
    expect((await patch({ modelImagePolicy: { model: 'deepseek-chat', policy: null } })).status).toBe(200);
    const clearedSession = await createSession(runtime);
    const clearedResponse = await prompt(runtime.baseUrl, runtime.project, clearedSession.id, 'images-probe cleared', {
      model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      parts: imageParts('images-probe cleared'),
    });
    expect(clearedResponse.status).toBe(200);
    const clearedPayload = await readImagesProbePayload(runtime, clearedSession.id);
    expect(calls).toEqual([dataUri]);
    expect(clearedPayload.images).toEqual([dataUri]);
  });

  test('converts images to prompt text and withholds them under the ocr image policy', async () => {
    const calls = [];
    const runtime = await createRuntime({
      imageConverters: {
        ocr: async (dataUri) => { calls.push(dataUri); return '扫描到的文字'; },
        caption: async () => { throw new Error('caption should not run'); },
        vlm: async () => { throw new Error('vlm should not run'); },
      },
    });
    await configureDeepSeek(runtime.baseUrl);
    await fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePolicy: 'ocr' }),
    });
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe describe', {
      parts: [
        { type: 'text', text: 'images-probe describe' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=', filename: 'shot.png' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAAIGZ0eXAAAAA=' },
      ],
    });
    expect(response.status).toBe(200);
    const payload = await readImagesProbePayload(runtime, session.id);
    expect(calls).toEqual(['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=', 'data:image/png;base64,AAAAIGZ0eXAAAAA=']);
    expect(payload.images).toBeNull();
    expect(payload.prompt).toContain('[图片 shot.png: 扫描到的文字]');
    expect(payload.prompt).toContain('[图片 2: 扫描到的文字]');
    expect(payload.prompt).not.toContain('base64,');
  });

  test('describes images through the vlm policy with the configured vision model', async () => {
    const vlmCalls = [];
    const runtime = await createRuntime({
      imageConverters: {
        ocr: async () => { throw new Error('ocr should not run'); },
        caption: async () => { throw new Error('caption should not run'); },
        vlm: async (dataUri, options) => { vlmCalls.push({ dataUri, options }); return '一只趴在键盘上的猫'; },
      },
    });
    await configureDeepSeek(runtime.baseUrl);
    await fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePolicy: 'vlm', imageVlmModel: 'gpt-4o' }),
    });
    const session = await createSession(runtime);
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=';
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe describe', {
      parts: [
        { type: 'text', text: 'images-probe describe' },
        { type: 'file', mime: 'image/png', url: dataUri, filename: 'shot.png' },
      ],
    });
    expect(response.status).toBe(200);
    const payload = await readImagesProbePayload(runtime, session.id);
    expect(vlmCalls).toHaveLength(1);
    expect(vlmCalls[0].dataUri).toBe(dataUri);
    expect(vlmCalls[0].options).toMatchObject({
      apiKey: 'test-key',
      providerType: 'openai_chat',
      model: 'gpt-4o',
    });
    expect(payload.images).toBeNull();
    expect(payload.prompt).toContain('[图片 shot.png: 一只趴在键盘上的猫]');
  });

  test('drops image attachments under the drop image policy without converting them', async () => {
    const runtime = await createRuntime({
      imageConverters: {
        ocr: async () => { throw new Error('ocr should not run'); },
        caption: async () => { throw new Error('caption should not run'); },
        vlm: async () => { throw new Error('vlm should not run'); },
      },
    });
    await configureDeepSeek(runtime.baseUrl);
    await fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePolicy: 'drop' }),
    });
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe describe', {
      parts: [
        { type: 'text', text: 'images-probe describe' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=', filename: 'shot.png' },
      ],
    });
    expect(response.status).toBe(200);
    const payload = await readImagesProbePayload(runtime, session.id);
    expect(payload.images).toBeNull();
    expect(payload.prompt).toContain('[Attached image shot.png]');
    expect(payload.prompt).not.toContain('base64,');
  });

  test('degrades a failed image conversion to a placeholder line without blocking the run', async () => {
    const runtime = await createRuntime({
      imageConverters: {
        ocr: async () => { throw new Error('tesseract exploded'); },
        caption: async () => { throw new Error('caption should not run'); },
        vlm: async () => { throw new Error('vlm should not run'); },
      },
    });
    await configureDeepSeek(runtime.baseUrl);
    await fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePolicy: 'ocr' }),
    });
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe describe', {
      parts: [
        { type: 'text', text: 'images-probe describe' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=', filename: 'shot.png' },
      ],
    });
    expect(response.status).toBe(200);
    const payload = await readImagesProbePayload(runtime, session.id);
    expect(payload.images).toBeNull();
    expect(payload.prompt).toContain('[图片 shot.png: 图片转述失败]');
  });

  test('vlm converter posts the configured model and image to chat completions', async () => {
    const requests = [];
    const converters = createImageConverters({
      dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hao-converters-')),
      logger: { log() {}, error() {}, warn() {} },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '一只猫坐在窗台上' } }] }),
        };
      },
    });
    const text = await converters.vlm('data:image/png;base64,AAAABBBB', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.test/v1/',
      providerType: 'openai_chat',
      model: 'gpt-4o',
    });
    expect(text).toBe('一只猫坐在窗台上');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.example.test/v1/chat/completions');
    expect(requests[0].init.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(requests[0].init.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } });
  });

  test('vlm converter speaks the anthropic messages format for anthropic providers', async () => {
    const requests = [];
    const converters = createImageConverters({
      dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hao-converters-')),
      logger: { log() {}, error() {}, warn() {} },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: '一张截图' }] }),
        };
      },
    });
    const text = await converters.vlm('data:image/png;base64,AAAABBBB', {
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.test',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(text).toBe('一张截图');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.anthropic.test/v1/messages');
    expect(requests[0].init.headers['x-api-key']).toBe('sk-ant');
    const body = JSON.parse(requests[0].init.body);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.messages[0].content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' },
    });
  });

  test('vlm converter rejects non-ok responses so callers can degrade', async () => {
    const converters = createImageConverters({
      dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hao-converters-')),
      logger: { log() {}, error() {}, warn() {} },
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });
    await expect(converters.vlm('data:image/png;base64,AAAA', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.test/v1',
      providerType: 'openai_chat',
      model: 'gpt-4o',
    })).rejects.toThrow('429');
  });
});

describe('session revert/unrevert endpoints', () => {
  const postJson = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  const firstMessageId = async (baseUrl, sessionId) => {
    const records = await waitFor(async () => {
      const messages = await fetch(`${baseUrl}/session/${sessionId}/message`).then((item) => item.json());
      return messages.length ? messages : null;
    });
    return records[0].info.id;
  };

  test('revert sets a session-level marker and unrevert clears it', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);
    expect((await prompt(runtime.baseUrl, runtime.project, session.id, 'hello')).status).toBe(200);
    const messageId = await firstMessageId(runtime.baseUrl, session.id);

    const reverted = await postJson(`${runtime.baseUrl}/session/${session.id}/revert`, { messageID: messageId, partID: 'part_1' })
      .then((item) => item.json());
    expect(reverted.revert).toEqual({ messageID: messageId, partID: 'part_1' });

    const listed = await fetch(`${runtime.baseUrl}/session?directory=${encodeURIComponent(runtime.project)}`).then((item) => item.json());
    expect(listed.find((item) => item.id === session.id).revert.messageID).toBe(messageId);

    const unreverted = await postJson(`${runtime.baseUrl}/session/${session.id}/unrevert`).then((item) => item.json());
    expect(unreverted.revert).toBeUndefined();
  });

  test('revert rejects unknown sessions with 404', async () => {
    const runtime = await createRuntime();
    const response = await postJson(`${runtime.baseUrl}/session/sess_missing/revert`, { messageID: 'msg_x' });
    expect(response.status).toBe(404);
  });

  test('unrevert rejects unknown sessions with 404', async () => {
    const runtime = await createRuntime();
    const response = await postJson(`${runtime.baseUrl}/session/sess_missing/unrevert`);
    expect(response.status).toBe(404);
  });

  test('revert requires messageID and rejects unknown messages with 400', async () => {
    const runtime = await createRuntime();
    const session = await createSession(runtime);

    const missing = await postJson(`${runtime.baseUrl}/session/${session.id}/revert`);
    expect(missing.status).toBe(400);

    const unknownMessage = await postJson(`${runtime.baseUrl}/session/${session.id}/revert`, { messageID: 'msg_nope' });
    expect(unknownMessage.status).toBe(400);
    const body = await unknownMessage.json();
    expect(body.error).toMatch(/Message not found/);
  });
});

describe('message id ordering for revert visibility', () => {
  const promptWithoutId = (baseUrl, project, sessionId, text) => fetch(
    `${baseUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(project)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        parts: [{ type: 'text', text }],
      }),
    },
  );

  test('server-generated ids stay lexicographically ascending so revert keeps earlier turns', async () => {
    const runtime = await createRuntime();
    await configureDeepSeek(runtime.baseUrl);
    const session = await createSession(runtime);

    expect((await promptWithoutId(runtime.baseUrl, runtime.project, session.id, 'first')).status).toBe(200);
    await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      return messages.some((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    expect((await promptWithoutId(runtime.baseUrl, runtime.project, session.id, 'second')).status).toBe(200);
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${session.id}/message`).then((item) => item.json());
      const assistants = messages.filter((record) => record.info.role === 'assistant' && record.info.finish === 'stop');
      return assistants.length >= 2 ? messages : null;
    });

    const ids = records.map((record) => record.info.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);

    // Reverting at the second user message must keep the entire first turn
    // visible under the UI's `message.id < revertMessageID` filter.
    const secondUserId = records.filter((record) => record.info.role === 'user')[1].info.id;
    const visible = records.filter((record) => record.info.id < secondUserId);
    expect(visible.some((record) => record.info.role === 'assistant')).toBe(true);

    // And the server assistant id of the second turn sorts after the prompt.
    const secondAssistant = records.filter((record) => record.info.role === 'assistant')[1];
    expect(secondAssistant.info.id > secondUserId).toBe(true);
  });
});

describe('caption image policy runs OCR and caption combined', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=';
  const imageParts = (text) => [
    { type: 'text', text },
    { type: 'file', mime: 'image/png', url: dataUri, filename: 'shot.png' },
  ];
  const setup = async (converters) => {
    const runtime = await createRuntime({ imageConverters: { vlm: async () => { throw new Error('vlm should not run'); }, ...converters } });
    await configureDeepSeek(runtime.baseUrl);
    const response = await fetch(`${runtime.baseUrl}/provider/deepseek/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePolicy: 'caption' }),
    });
    expect(response.status).toBe(200);
    return runtime;
  };
  const readPayload = async (runtime, sessionId) => {
    const records = await waitFor(async () => {
      const messages = await fetch(`${runtime.baseUrl}/session/${sessionId}/message`).then((item) => item.json());
      return messages.find((record) => record.info.role === 'assistant' && record.info.finish === 'stop') ? messages : null;
    });
    return JSON.parse(records.find((record) => record.info.role === 'assistant').parts.find((part) => part.type === 'text').text);
  };

  test('combines OCR text and scene description into one prompt section', async () => {
    const runtime = await setup({
      ocr: async () => '图中文字',
      caption: async () => 'a screenshot of a chart',
    });
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe combined', { parts: imageParts('images-probe combined') });
    expect(response.status).toBe(200);
    const payload = await readPayload(runtime, session.id);
    expect(payload.images).toBeNull();
    expect(payload.prompt).toContain('[识别文字]\n图中文字');
    expect(payload.prompt).toContain('[画面描述]\na screenshot of a chart');
  });

  test('degrades to the surviving section when one half fails', async () => {
    const runtime = await setup({
      ocr: async () => { throw new Error('ocr broke'); },
      caption: async () => 'a screenshot of a chart',
    });
    const session = await createSession(runtime);
    const response = await prompt(runtime.baseUrl, runtime.project, session.id, 'images-probe degraded', { parts: imageParts('images-probe degraded') });
    expect(response.status).toBe(200);
    const payload = await readPayload(runtime, session.id);
    expect(payload.prompt).not.toContain('[识别文字]');
    expect(payload.prompt).toContain('[画面描述]\na screenshot of a chart');
  });
});
