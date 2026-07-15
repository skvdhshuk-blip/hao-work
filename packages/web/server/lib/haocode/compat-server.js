import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createHaoCodeStore, createId, projectIdForDirectory } from './store.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import { getModelsMetadata } from '../opencode/models-metadata.js';
import { getAgentConfig, listAgentConfigs } from '../opencode/agents.js';
import { listCommandConfigs } from '../opencode/commands.js';
import { listMcpConfigs } from '../opencode/mcp.js';

const execFileAsync = promisify(execFile);
const DEFAULT_DIRECTORY = process.cwd();
const DEFAULT_MODEL_LIMIT = Object.freeze({ context: 200_000, output: 16_384 });

const PROVIDER_DEFINITIONS = {
  anthropic: {
    name: 'Anthropic',
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    env: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-20250514'],
  },
  openai: {
    name: 'OpenAI',
    providerType: 'openai',
    baseUrl: 'https://api.openai.com',
    env: 'OPENAI_API_KEY',
    models: ['gpt-5', 'gpt-4.1'],
  },
  deepseek: {
    name: 'DeepSeek',
    providerType: 'openai_chat',
    baseUrl: 'https://api.deepseek.com',
    env: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
};

const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const catalogProvider = (metadata, providerId) => {
  if (!metadata || typeof metadata !== 'object') return null;
  if (metadata[providerId] && typeof metadata[providerId] === 'object') return metadata[providerId];
  return Object.values(metadata).find((provider) => provider?.id === providerId) ?? null;
};

const resolveModelLimit = ({ metadata, providerId, modelId, saved = {} }) => {
  const catalogLimit = catalogProvider(metadata, providerId)?.models?.[modelId]?.limit;
  return {
    context: positiveInteger(saved.contextWindow)
      ?? positiveInteger(catalogLimit?.context)
      ?? DEFAULT_MODEL_LIMIT.context,
    output: positiveInteger(saved.maxTokens)
      ?? positiveInteger(catalogLimit?.output)
      ?? DEFAULT_MODEL_LIMIT.output,
  };
};

const modelDefinition = (providerID, id, limit) => ({
  id,
  providerID,
  api: { id, url: PROVIDER_DEFINITIONS[providerID]?.baseUrl ?? '', npm: '' },
  name: id,
  capabilities: {
    temperature: true,
    reasoning: /reason|thinking|r1/i.test(id),
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: /reason|thinking|r1/i.test(id),
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit,
  status: 'active',
  options: {},
  headers: {},
  release_date: '2025-01-01',
});

const normalizeDirectory = (value) => {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_DIRECTORY;
  return path.resolve(value.trim());
};

const resolveUnderDirectory = (directory, candidate = '.') => {
  const root = normalizeDirectory(directory);
  const absolute = path.resolve(root, candidate || '.');
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Path escapes the selected project directory.'), { status: 403 });
  }
  return { root, absolute, relative };
};

const sessionTitleFromPrompt = (prompt) => {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, 80) || 'New session';
};

const extractPrompt = (parts) => {
  const output = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type === 'text' && typeof part.text === 'string') output.push(part.text);
    if (part?.type === 'file' && typeof part.url === 'string') {
      output.push(`[Attached file${part.filename ? ` ${part.filename}` : ''}: ${part.url}]`);
    }
    if (part?.type === 'agent' && typeof part.name === 'string') output.push(`@${part.name}`);
  }
  return output.join('\n\n').trim();
};

const writeSse = (response, payload) => {
  response.write(`id: ${payload.id || createId('evt')}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const questionInfo = (input) => {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions.map((question, index) => ({
    question: String(question?.question || question?.prompt || 'Please provide input.'),
    header: String(question?.header || question?.label || `Question ${index + 1}`).slice(0, 30),
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => (
      typeof option === 'string'
        ? { label: option, description: '' }
        : { label: String(option?.label || ''), description: String(option?.description || '') }
    )),
    multiple: Boolean(question?.multiple ?? question?.multiSelect),
    custom: question?.custom !== false,
  }));
};

const mcpSettings = (servers) => ({
  mcp_servers: Object.fromEntries(servers.map((server) => {
    const definition = server.type === 'remote'
      ? {
          transport: 'http',
          url: server.url,
          headers: server.headers,
          oauth: server.oauth,
        }
      : {
          transport: 'stdio',
          command: server.command?.[0],
          args: server.command?.slice(1) ?? [],
          env: server.environment,
        };
    return [server.name, Object.fromEntries(Object.entries({
      ...definition,
      enabled: server.enabled !== false,
    }).filter(([, value]) => value !== undefined))];
  })),
});

const gitStatus = async (directory) => {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: directory,
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const records = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).replace(/^"|"$/g, '');
    const file = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
    const status = code.includes('?') || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified';
    records.push({ file, additions: 0, deletions: 0, status });
  }
  const { stdout: numstat } = await execFileAsync('git', ['diff', '--numstat', 'HEAD', '--'], {
    cwd: directory,
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const counts = new Map(numstat.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...fileParts] = line.split('\t');
    return [fileParts.join('\t'), { additions: Number(added) || 0, deletions: Number(removed) || 0 }];
  }));
  return Promise.all(records.map(async (record) => {
    if (record.status === 'added' && !counts.has(record.file)) {
      try {
        const contents = await fs.readFile(path.join(directory, record.file), 'utf8');
        return { ...record, additions: contents ? contents.split('\n').length : 0 };
      } catch { return record; }
    }
    return { ...record, ...(counts.get(record.file) ?? {}) };
  }));
};

const gitDiff = async (directory) => {
  const statuses = await gitStatus(directory);
  return Promise.all(statuses.map(async (record) => {
    try {
      const args = record.status === 'added'
        ? ['diff', '--no-index', '--', '/dev/null', record.file]
        : ['diff', 'HEAD', '--', record.file];
      const { stdout } = await execFileAsync('git', args, {
        cwd: directory,
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      }).catch((error) => ({ stdout: error.stdout || '' }));
      return { ...record, patch: stdout };
    } catch { return { ...record, patch: '' }; }
  }));
};

export const createHaoCodeCompatibilityServer = ({
  dataDir,
  logger = console,
  workerOptions = {},
  modelsMetadataLoader = getModelsMetadata,
}) => {
  const app = express();
  const server = http.createServer(app);
  const store = createHaoCodeStore({ rootDir: path.join(dataDir, 'haocode') });
  const supervisor = createWorkerSupervisor(workerOptions);
  const globalEventClients = new Set();
  const directoryEventClients = new Map();
  const activeRuns = new Set();
  let haoCodeVersionPromise = null;
  let eventSequence = 0;
  let listeningPort = null;

  app.use(express.json({ limit: '20mb' }));

  const resolveHaoCodeVersion = () => {
    if (!haoCodeVersionPromise) {
      const lockPath = path.join(path.dirname(supervisor.workerPath), 'composer.lock');
      haoCodeVersionPromise = fs.readFile(lockPath, 'utf8')
        .then((contents) => JSON.parse(contents))
        .then((lock) => lock?.packages?.find((entry) => entry?.name === 'sk-wang/hao-code')?.version)
        .then((version) => typeof version === 'string' && version.trim() ? version.replace(/^v/, '') : 'unknown')
        .catch(() => 'unknown');
    }
    return haoCodeVersionPromise;
  };

  const event = (type, properties) => ({
    id: `evt_${Date.now().toString(36)}_${(++eventSequence).toString(36)}`,
    type,
    properties,
  });

  const publish = (directory, payload) => {
    const normalizedDirectory = normalizeDirectory(directory);
    for (const response of globalEventClients) {
      writeSse(response, {
        directory: normalizedDirectory,
        payload,
        id: payload.id,
      });
    }
    for (const response of directoryEventClients.get(normalizedDirectory) ?? []) {
      writeSse(response, payload);
    }
  };

  const openEventStream = (request, response, global = false) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(': hao-work-haocode\n\n');
    const directory = normalizeDirectory(request.query.directory);
    const clients = global
      ? globalEventClients
      : (directoryEventClients.get(directory) ?? new Set());
    if (!global) directoryEventClients.set(directory, clients);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
    request.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(response);
      if (!global && clients.size === 0) directoryEventClients.delete(directory);
    });
  };

  const setStatus = async (sessionId, directory, status) => {
    await store.mutate((state) => {
      if (status.type === 'idle') delete state.statuses[sessionId];
      else state.statuses[sessionId] = status;
    });
    publish(directory, event('session.status', { sessionID: sessionId, status }));
    if (status.type === 'idle') publish(directory, event('session.idle', { sessionID: sessionId }));
  };

  const loadModelsMetadata = async () => {
    try {
      const result = await modelsMetadataLoader();
      return result?.metadata && typeof result.metadata === 'object' ? result.metadata : {};
    } catch (error) {
      logger.warn?.(`Unable to load models.dev metadata; using HaoCode defaults: ${error.message}`);
      return {};
    }
  };

  const providerSettings = async (providerId, requestedModel) => {
    const definition = PROVIDER_DEFINITIONS[providerId] ?? PROVIDER_DEFINITIONS.deepseek;
    const saved = await store.getProviderSettings(providerId);
    const model = requestedModel || saved.model || definition.models[0];
    const limit = resolveModelLimit({
      metadata: await loadModelsMetadata(),
      providerId,
      modelId: model,
      saved,
    });
    return {
      apiKey: saved.apiKey || process.env[definition.env] || null,
      baseUrl: saved.baseUrl || definition.baseUrl,
      providerType: saved.providerType || definition.providerType,
      model,
      contextWindow: limit.context,
      maxTokens: limit.output,
    };
  };

  const upsertPart = async (sessionId, messageId, part, broadcast = true) => {
    await store.mutate((state) => {
      const records = state.messages[sessionId] ?? [];
      const record = records.find((item) => item.info.id === messageId);
      if (!record) return;
      const index = record.parts.findIndex((item) => item.id === part.id);
      if (index >= 0) record.parts[index] = part;
      else record.parts.push(part);
    });
    if (broadcast) {
      publish(part.directory, event('message.part.updated', {
        sessionID: sessionId,
        part: Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'directory')),
        time: Date.now(),
      }));
    }
  };

  const updateAssistant = async (sessionId, messageId, directory, updater) => {
    let info = null;
    await store.mutate((state) => {
      const record = (state.messages[sessionId] ?? []).find((item) => item.info.id === messageId);
      if (!record) return;
      updater(record.info);
      info = { ...record.info };
    });
    if (info) publish(directory, event('message.updated', { sessionID: sessionId, info }));
  };

  const createPendingInterrupts = async ({ session, assistantId, interrupt }) => {
    const actions = Array.isArray(interrupt?.actions) ? interrupt.actions : [];
    await store.mutate((state) => {
      state.interrupts[interrupt.id] = {
        id: interrupt.id,
        sessionId: session.id,
        haocodeSessionId: interrupt.session_id,
        directory: session.directory,
        actions,
        decisions: {},
      };
      const updatedSession = state.sessions.find((item) => item.id === session.id);
      if (updatedSession) {
        updatedSession.metadata = {
          ...(updatedSession.metadata ?? {}),
          _fe_haocodeSessionId: interrupt.session_id,
        };
        updatedSession.time.updated = Date.now();
      }
      for (const action of actions) {
        const requestId = `req_${action.id}`;
        if (action.tool_name === 'AskUserQuestion') {
          state.questions.push({
            id: requestId,
            sessionID: session.id,
            directory: session.directory,
            questions: questionInfo(action.input),
            tool: { messageID: assistantId, callID: action.id },
            _fe_interruptId: interrupt.id,
            _fe_actionId: action.id,
          });
        } else {
          state.permissions.push({
            id: requestId,
            sessionID: session.id,
            directory: session.directory,
            permission: action.tool_name || 'tool',
            patterns: [action.description || action.tool_name || 'Tool execution'],
            metadata: {
              input: action.input ?? {},
              description: action.description ?? '',
              _fe_interruptId: interrupt.id,
              _fe_actionId: action.id,
            },
            always: [],
            tool: { messageID: assistantId, callID: action.id },
          });
        }
      }
    });

    for (const action of actions) {
      const requestId = `req_${action.id}`;
      if (action.tool_name === 'AskUserQuestion') {
        publish(session.directory, event('question.asked', {
          id: requestId,
          sessionID: session.id,
          questions: questionInfo(action.input),
          tool: { messageID: assistantId, callID: action.id },
        }));
      } else {
        publish(session.directory, event('permission.asked', {
          id: requestId,
          sessionID: session.id,
          permission: action.tool_name || 'tool',
          patterns: [action.description || action.tool_name || 'Tool execution'],
          metadata: {
            input: action.input ?? {},
            description: action.description ?? '',
            _fe_interruptId: interrupt.id,
            _fe_actionId: action.id,
          },
          always: [],
          tool: { messageID: assistantId, callID: action.id },
        }));
      }
    }
  };

  const runSession = async ({ session, parentMessageId, providerId, modelId, request }) => {
    const assistantId = createId('msg');
    const now = Date.now();
    const assistant = {
      id: assistantId,
      sessionID: session.id,
      role: 'assistant',
      time: { created: now },
      parentID: parentMessageId,
      modelID: modelId,
      providerID: providerId,
      mode: 'build',
      agent: 'build',
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await store.mutate((state) => {
      state.messages[session.id] ??= [];
      state.messages[session.id].push({ info: assistant, parts: [] });
      const storedSession = state.sessions.find((item) => item.id === session.id);
      if (storedSession) storedSession.time.updated = now;
    });
    publish(session.directory, event('message.updated', { sessionID: session.id, info: assistant }));
    await setStatus(session.id, session.directory, { type: 'busy' });

    let textPart = null;
    let reasoningPart = null;
    const runningTools = [];
    let eventQueue = Promise.resolve();
    let terminalEvent = false;

    const handleWorkerEvent = async (message) => {
      if (message.type === 'text' && message.text) {
        if (!textPart) {
          textPart = {
            id: createId('part'), sessionID: session.id, messageID: assistantId, type: 'text', text: '',
            time: { start: Date.now() }, directory: session.directory,
          };
          await upsertPart(session.id, assistantId, textPart);
        }
        textPart.text += message.text;
        await upsertPart(session.id, assistantId, textPart, false);
        publish(session.directory, event('message.part.delta', {
          sessionID: session.id, messageID: assistantId, partID: textPart.id, field: 'text', delta: message.text,
        }));
        return;
      }
      if (message.type === 'thinking' && message.text) {
        if (!reasoningPart) {
          reasoningPart = {
            id: createId('part'), sessionID: session.id, messageID: assistantId, type: 'reasoning', text: '',
            time: { start: Date.now() }, directory: session.directory,
          };
          await upsertPart(session.id, assistantId, reasoningPart);
        }
        reasoningPart.text += message.text;
        await upsertPart(session.id, assistantId, reasoningPart, false);
        publish(session.directory, event('message.part.delta', {
          sessionID: session.id, messageID: assistantId, partID: reasoningPart.id, field: 'text', delta: message.text,
        }));
        return;
      }
      if (message.type === 'tool_start') {
        const part = {
          id: createId('part'),
          sessionID: session.id,
          messageID: assistantId,
          type: 'tool',
          callID: createId('call'),
          tool: message.toolName || 'tool',
          state: { status: 'running', input: message.toolInput ?? {}, time: { start: Date.now() } },
          directory: session.directory,
        };
        runningTools.push(part);
        if (message.toolName === 'TodoWrite' && Array.isArray(message.toolInput?.todos)) {
          const todos = message.toolInput.todos.map((todo) => ({
            content: String(todo?.content || ''),
            status: String(todo?.status || 'pending'),
            priority: String(todo?.priority || 'medium'),
          })).filter((todo) => todo.content);
          await store.mutate((state) => { state.todos[session.id] = todos; });
          publish(session.directory, event('todo.updated', { sessionID: session.id, todos }));
        }
        await upsertPart(session.id, assistantId, part);
        return;
      }
      if (message.type === 'tool_result') {
        const part = [...runningTools].reverse().find((item) => item.tool === message.toolName && item.state.status === 'running');
        if (!part) return;
        const start = part.state.time.start;
        part.state = message.toolIsError
          ? { status: 'error', input: part.state.input, error: message.toolOutput || 'Tool failed', time: { start, end: Date.now() } }
          : { status: 'completed', input: part.state.input, output: message.toolOutput || '', title: part.tool, metadata: {}, time: { start, end: Date.now() } };
        await upsertPart(session.id, assistantId, part);
        return;
      }
      if (message.type === 'interrupt' && message.interrupt) {
        terminalEvent = true;
        await createPendingInterrupts({ session, assistantId, interrupt: message.interrupt });
        await updateAssistant(session.id, assistantId, session.directory, (info) => {
          info.time.completed = Date.now();
          info.finish = 'interrupt';
        });
        return;
      }
      if (message.type === 'error') {
        terminalEvent = true;
        await updateAssistant(session.id, assistantId, session.directory, (info) => {
          info.time.completed = Date.now();
          info.error = { name: 'UnknownError', data: { message: message.error || 'HaoCode failed.' } };
          info.finish = 'error';
        });
        publish(session.directory, event('session.error', {
          sessionID: session.id,
          error: { name: 'UnknownError', data: { message: message.error || 'HaoCode failed.' } },
        }));
        return;
      }
      if (message.type === 'result') {
        terminalEvent = true;
        const usage = message.usage ?? {};
        await updateAssistant(session.id, assistantId, session.directory, (info) => {
          info.time.completed = Date.now();
          info.cost = Number(message.cost) || 0;
          info.tokens = {
            input: Number(usage.input_tokens) || 0,
            output: Number(usage.output_tokens) || 0,
            reasoning: 0,
            cache: {
              read: Number(usage.cache_read_tokens) || 0,
              write: Number(usage.cache_creation_tokens) || 0,
            },
          };
          info.finish = 'stop';
        });
        await store.mutate((state) => {
          const stored = state.sessions.find((item) => item.id === session.id);
          if (!stored) return;
          stored.cost = (stored.cost ?? 0) + (Number(message.cost) || 0);
          stored.metadata = {
            ...(stored.metadata ?? {}),
            ...(message.sessionId ? { _fe_haocodeSessionId: message.sessionId } : {}),
          };
          stored.time.updated = Date.now();
        });
      }
    };

    try {
      const servers = listMcpConfigs(session.directory);
      let mcpSettingsPath = null;
      if (servers.length) {
        mcpSettingsPath = path.join(dataDir, 'haocode', 'mcp', `${projectIdForDirectory(session.directory)}.json`);
        await fs.mkdir(path.dirname(mcpSettingsPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(mcpSettingsPath, `${JSON.stringify(mcpSettings(servers), null, 2)}\n`, { mode: 0o600 });
      }
      await supervisor.run({
        sessionId: session.id,
        request: {
          ...request,
          cwd: session.directory,
          storagePath: path.join(dataDir, 'haocode-sdk'),
          provider: await providerSettings(providerId, modelId),
          haocodeSessionId: session.metadata?._fe_haocodeSessionId ?? request.haocodeSessionId ?? null,
          thinkingEnabled: /reason|thinking|r1/i.test(modelId),
          ...(mcpSettingsPath ? { mcpSettingsPath, allowedTools: ['*'] } : {}),
        },
        onEvent: (message) => {
          eventQueue = eventQueue.then(() => handleWorkerEvent(message));
        },
      });
      await eventQueue;
      if (!terminalEvent) {
        await handleWorkerEvent({ type: 'error', error: 'HaoCode worker completed without a final result.' });
      }
    } catch (error) {
      await eventQueue;
      const aborted = /SIGTERM|SIGKILL|aborted/i.test(error.message);
      await updateAssistant(session.id, assistantId, session.directory, (info) => {
        info.time.completed = Date.now();
        info.error = aborted
          ? { name: 'MessageAbortedError', data: { message: 'Generation was stopped.' } }
          : { name: 'UnknownError', data: { message: error.message } };
        info.finish = aborted ? 'abort' : 'error';
      });
      if (!aborted) publish(session.directory, event('session.error', {
        sessionID: session.id,
        error: { name: 'UnknownError', data: { message: error.message } },
      }));
    } finally {
      await setStatus(session.id, session.directory, { type: 'idle' });
    }
  };

  const startRun = (options) => {
    const operation = runSession(options)
      .catch((error) => logger.error?.('[HaoCode compat] Session run failed', error))
      .finally(() => activeRuns.delete(operation));
    activeRuns.add(operation);
    return operation;
  };

  const resolveInterrupt = async ({ requestId, reply, answers }) => {
    let resolution = null;
    await store.mutate((state) => {
      const pending = state.permissions.find((item) => item.id === requestId)
        ?? state.questions.find((item) => item.id === requestId);
      if (!pending) return;
      const interruptId = pending._fe_interruptId ?? pending.metadata?._fe_interruptId;
      const actionId = pending._fe_actionId ?? pending.metadata?._fe_actionId;
      const interrupt = state.interrupts[interruptId];
      if (!interrupt) return;
      const action = interrupt.actions.find((item) => item.id === actionId);
      interrupt.decisions[actionId] = action?.tool_name === 'AskUserQuestion'
        ? { action_id: actionId, type: 'respond', response: { status: reply === 'reject' ? 'cancelled' : 'answered', answers: answers ?? [] } }
        : reply === 'reject'
          ? { action_id: actionId, type: 'reject', message: 'Rejected by the Hao Work user.' }
          : { action_id: actionId, type: 'approve' };
      state.permissions = state.permissions.filter((item) => item.id !== requestId);
      state.questions = state.questions.filter((item) => item.id !== requestId);
      resolution = {
        directory: pending.directory,
        sessionId: pending.sessionID,
        continuation: null,
      };
      if (interrupt.actions.every((item) => interrupt.decisions[item.id])) {
        resolution.continuation = {
          ...interrupt,
          decisions: interrupt.actions.map((item) => interrupt.decisions[item.id]),
        };
        delete state.interrupts[interruptId];
      }
    });
    if (!resolution) return null;
    const continuation = resolution.continuation;
    if (!continuation) return resolution;
    const session = await store.getSession(continuation.sessionId);
    if (!session) return resolution;
    const messages = await store.getMessages(session.id);
    const parentMessageId = [...messages].reverse().find((record) => record.info.role === 'user')?.info.id ?? createId('msg');
    void startRun({
      session,
      parentMessageId,
      providerId: session.model?.providerID || 'deepseek',
      modelId: session.model?.id || 'deepseek-chat',
      request: {
        action: 'resume_interrupt',
        interruptId: continuation.id,
        haocodeSessionId: continuation.haocodeSessionId,
        decisions: continuation.decisions,
      },
    });
    return resolution;
  };

  app.get('/global/health', async (_request, response) => response.json({
    healthy: true,
    version: 'haocode-1',
    _fe_agentEngine: 'haocode',
    _fe_haocodeVersion: await resolveHaoCodeVersion(),
    _fe_phpRuntime: supervisor.phpBinary,
  }));
  app.get('/global/event', (request, response) => openEventStream(request, response, true));
  app.get('/event', (request, response) => openEventStream(request, response, false));

  app.get('/path', (request, response) => {
    const directory = normalizeDirectory(request.query.directory);
    response.json({
      state: store.rootDir,
      config: dataDir,
      worktree: directory,
      directory,
      home: os.homedir(),
    });
  });

  const projectFor = (directory) => ({
    id: projectIdForDirectory(directory),
    worktree: directory,
    name: path.basename(directory),
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  });
  app.get('/project', async (request, response) => {
    const sessions = await store.listSessions();
    const directories = new Set(sessions.map((session) => session.directory));
    if (request.query.directory) directories.add(normalizeDirectory(request.query.directory));
    response.json([...directories].map(projectFor));
  });
  app.get('/project/current', (request, response) => response.json(projectFor(normalizeDirectory(request.query.directory))));

  app.get('/config', async (_request, response) => response.json({
    ...(await store.getConfig()),
    model: 'deepseek/deepseek-chat',
    _fe_agentEngine: 'haocode',
  }));
  app.get('/global/config', async (_request, response) => response.json({
    ...(await store.getConfig()),
    model: 'deepseek/deepseek-chat',
    _fe_agentEngine: 'haocode',
  }));
  app.patch('/config', async (request, response) => {
    const config = request.body && typeof request.body === 'object' ? request.body : {};
    await store.mutate((state) => { state.config = { ...state.config, ...config }; });
    response.json({ ...config, _fe_agentEngine: 'haocode' });
  });

  app.get('/config/providers', async (_request, response) => {
    const metadata = await loadModelsMetadata();
    const providers = await Promise.all(Object.entries(PROVIDER_DEFINITIONS).map(async ([id, definition]) => {
      const saved = await store.getProviderSettings(id);
      const models = [...new Set([...(definition.models ?? []), ...(Array.isArray(saved.models) ? saved.models : [])])];
      return {
        id,
        name: definition.name,
        source: saved.apiKey || process.env[definition.env] ? 'api' : 'custom',
        env: [definition.env],
        options: {
          baseURL: saved.baseUrl || definition.baseUrl,
          _fe_providerType: saved.providerType || definition.providerType,
        },
        models: Object.fromEntries(models.map((model) => [model, modelDefinition(
          id,
          model,
          resolveModelLimit({ metadata, providerId: id, modelId: model, saved }),
        )])),
      };
    }));
    response.json({
      providers,
      default: Object.fromEntries(providers.map((provider) => [provider.id, Object.keys(provider.models)[0]])),
    });
  });
  app.get('/provider/auth', (_request, response) => response.json(Object.fromEntries(
    Object.keys(PROVIDER_DEFINITIONS).map((id) => [id, [{ type: 'api', label: `${PROVIDER_DEFINITIONS[id].name} API key` }]]),
  )));
  app.get('/provider/:providerID/source', async (request, response) => {
    const providerId = request.params.providerID;
    const definition = PROVIDER_DEFINITIONS[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    const saved = await store.getProviderSettings(providerId);
    const authExists = Boolean(saved.apiKey || process.env[definition.env]);
    return response.json({
      providerId,
      sources: {
        auth: { exists: authExists, path: null },
        user: { exists: false, path: null },
        project: { exists: false, path: null },
        custom: { exists: Boolean(saved.baseUrl || saved.providerType || saved.models?.length), path: path.join(dataDir, 'haocode', 'runtime-state.json') },
      },
      _fe_agentEngine: 'haocode',
    });
  });
  app.get('/provider/:providerID/settings', async (request, response) => {
    const providerId = request.params.providerID;
    const definition = PROVIDER_DEFINITIONS[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    const saved = await store.getProviderSettings(providerId);
    return response.json({
      providerId,
      baseUrl: saved.baseUrl || definition.baseUrl,
      providerType: saved.providerType || definition.providerType,
      models: Array.isArray(saved.models) ? saved.models : [],
      _fe_agentEngine: 'haocode',
    });
  });
  app.patch('/provider/:providerID/settings', async (request, response) => {
    const providerId = request.params.providerID;
    const definition = PROVIDER_DEFINITIONS[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    const baseUrl = typeof request.body?.baseUrl === 'string' ? request.body.baseUrl.trim() : '';
    const providerType = typeof request.body?.providerType === 'string' ? request.body.providerType.trim() : '';
    const model = typeof request.body?.model === 'string' ? request.body.model.trim() : '';
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return response.status(400).json({ error: 'Base URL must use http or https.' });
    if (providerType && !['anthropic', 'openai', 'openai_chat'].includes(providerType)) {
      return response.status(400).json({ error: 'Unsupported HaoCode provider type.' });
    }
    await store.mutate((state) => {
      const saved = state.providers[providerId] ?? {};
      if (baseUrl) saved.baseUrl = baseUrl;
      else delete saved.baseUrl;
      if (providerType) saved.providerType = providerType;
      else delete saved.providerType;
      if (model) saved.models = [...new Set([...(Array.isArray(saved.models) ? saved.models : []), model])];
      state.providers[providerId] = saved;
    });
    const saved = await store.getProviderSettings(providerId);
    return response.json({
      providerId,
      baseUrl: saved.baseUrl || definition.baseUrl,
      providerType: saved.providerType || definition.providerType,
      models: Array.isArray(saved.models) ? saved.models : [],
      _fe_agentEngine: 'haocode',
    });
  });
  app.put('/auth/:providerID', async (request, response) => {
    const providerId = request.params.providerID;
    if (!PROVIDER_DEFINITIONS[providerId]) return response.status(404).json({ error: 'Unknown provider.' });
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    if (!key) return response.status(400).json({ error: 'API key is required.' });
    await store.mutate((state) => {
      state.providers[providerId] = { ...(state.providers[providerId] ?? {}), apiKey: key };
    });
    return response.json(true);
  });
  app.delete('/auth/:providerID', async (request, response) => {
    await store.mutate((state) => {
      if (state.providers[request.params.providerID]) delete state.providers[request.params.providerID].apiKey;
    });
    response.json(true);
  });

  app.get('/agent', (request, response) => response.json([{
    name: 'build',
    description: 'HaoCode coding agent',
    mode: 'primary',
    native: true,
    permission: [],
    options: {},
  }, ...listAgentConfigs(normalizeDirectory(request.query.directory)).map(({ name, ...config }) => ({
    name,
    description: config.description,
    mode: ['subagent', 'primary', 'all'].includes(config.mode) ? config.mode : 'all',
    native: false,
    hidden: Boolean(config.hidden),
    permission: config.permission ?? [],
    prompt: config.prompt,
    options: {},
  }))]));
  app.get('/command', (request, response) => response.json(
    listCommandConfigs(normalizeDirectory(request.query.directory)).map(({ name, ...config }) => ({
      name,
      description: config.description,
      agent: config.agent,
      model: config.model,
      source: 'command',
      template: String(config.template || ''),
      subtask: Boolean(config.subtask),
      hints: Array.isArray(config.hints) ? config.hints : [],
    })),
  ));
  app.get('/mcp', (request, response) => response.json(Object.fromEntries(
    listMcpConfigs(normalizeDirectory(request.query.directory)).map((server) => [server.name,
      server.enabled === false
        ? { status: 'disabled' }
        : server.type === 'remote' && !server.url
          ? { status: 'failed', error: 'Remote MCP server URL is missing.' }
          : server.type === 'local' && !server.command?.length
            ? { status: 'failed', error: 'Local MCP server command is missing.' }
            : { status: 'connected' },
    ]),
  )));
  app.get('/lsp', (_request, response) => response.json([]));
  app.get('/experimental/tool/ids', (_request, response) => response.json([
    'Read', 'Write', 'Edit', 'apply_patch', 'Glob', 'Grep', 'Bash', 'LSP', 'TodoWrite', 'Skill', 'MemoryRead', 'MemoryWrite', 'AskUserQuestion',
  ]));

  app.get('/session/status', async (_request, response) => response.json(await store.getStatus()));
  app.get('/experimental/session', async (request, response) => {
    const directory = request.query.directory ? normalizeDirectory(request.query.directory) : null;
    const archived = request.query.archived === true || request.query.archived === 'true';
    const rootsOnly = request.query.roots === true || request.query.roots === 'true';
    const cursor = Number(request.query.cursor) || Number.POSITIVE_INFINITY;
    const limit = Math.max(1, Math.min(Number(request.query.limit) || 100, 500));
    const search = typeof request.query.search === 'string' ? request.query.search.toLowerCase() : '';
    const sessions = (await store.listSessions(directory))
      .filter((session) => Boolean(session.time?.archived) === archived)
      .filter((session) => !rootsOnly || !session.parentID)
      .filter((session) => (session.time?.updated ?? 0) < cursor)
      .filter((session) => !search || `${session.title} ${session.id}`.toLowerCase().includes(search))
      .slice(0, limit);
    if (sessions.length === limit) {
      response.setHeader('x-next-cursor', String(sessions[sessions.length - 1]?.time?.updated ?? ''));
    }
    response.json(sessions);
  });
  app.get('/session', async (request, response) => {
    const directory = request.query.directory ? normalizeDirectory(request.query.directory) : null;
    const limit = Math.max(1, Math.min(Number(request.query.limit) || 100, 500));
    const search = typeof request.query.search === 'string' ? request.query.search.toLowerCase() : '';
    const sessions = (await store.listSessions(directory))
      .filter((session) => !search || `${session.title} ${session.id}`.toLowerCase().includes(search))
      .slice(0, limit);
    response.json(sessions);
  });
  app.post('/session', async (request, response) => {
    const directory = normalizeDirectory(request.query.directory);
    const now = Date.now();
    const session = {
      id: createId('ses'),
      slug: createId('slug'),
      projectID: projectIdForDirectory(directory),
      directory,
      ...(request.body?.parentID ? { parentID: request.body.parentID } : {}),
      title: typeof request.body?.title === 'string' && request.body.title.trim() ? request.body.title.trim() : 'New session',
      version: 'haocode-1',
      metadata: { ...(request.body?.metadata ?? {}), _fe_agentEngine: 'haocode' },
      time: { created: now, updated: now },
    };
    await store.mutate((state) => {
      state.sessions.push(session);
      state.messages[session.id] = [];
    });
    publish(directory, event('session.created', { sessionID: session.id, info: session }));
    response.json(session);
  });
  app.get('/session/:sessionID', async (request, response) => {
    const session = await store.getSession(request.params.sessionID);
    if (!session) return response.status(404).json({ error: 'Session not found.' });
    return response.json(session);
  });
  app.patch('/session/:sessionID', async (request, response) => {
    let updated = null;
    await store.mutate((state) => {
      const session = state.sessions.find((item) => item.id === request.params.sessionID);
      if (!session) return;
      if (typeof request.body?.title === 'string') session.title = request.body.title;
      if (request.body?.metadata && typeof request.body.metadata === 'object') {
        session.metadata = { ...(session.metadata ?? {}), ...request.body.metadata, _fe_agentEngine: 'haocode' };
      }
      if (request.body?.time?.archived) session.time.archived = Number(request.body.time.archived);
      session.time.updated = Date.now();
      updated = { ...session };
    });
    if (!updated) return response.status(404).json({ error: 'Session not found.' });
    publish(updated.directory, event('session.updated', { sessionID: updated.id, info: updated }));
    return response.json(updated);
  });
  app.delete('/session/:sessionID', async (request, response) => {
    let removed = null;
    supervisor.abort(request.params.sessionID);
    await store.mutate((state) => {
      const index = state.sessions.findIndex((item) => item.id === request.params.sessionID);
      if (index < 0) return;
      [removed] = state.sessions.splice(index, 1);
      delete state.messages[request.params.sessionID];
      delete state.statuses[request.params.sessionID];
      delete state.todos[request.params.sessionID];
      state.permissions = state.permissions.filter((item) => item.sessionID !== request.params.sessionID);
      state.questions = state.questions.filter((item) => item.sessionID !== request.params.sessionID);
    });
    if (!removed) return response.status(404).json({ error: 'Session not found.' });
    publish(removed.directory, event('session.deleted', { sessionID: removed.id, info: removed }));
    return response.json(true);
  });
  app.get('/session/:sessionID/children', async (request, response) => response.json(
    (await store.listSessions()).filter((session) => session.parentID === request.params.sessionID),
  ));
  app.get('/session/:sessionID/todo', async (request, response) => response.json(await store.getTodos(request.params.sessionID)));
  app.get('/session/:sessionID/diff', async (request, response, next) => {
    try {
      const session = await store.getSession(request.params.sessionID);
      if (!session) return response.status(404).json({ error: 'Session not found.' });
      return response.json((await gitDiff(session.directory)).map(({ file, ...diff }) => ({ path: file, ...diff })));
    } catch (error) { return next(error); }
  });
  app.get('/session/:sessionID/message', async (request, response) => {
    const records = await store.getMessages(request.params.sessionID);
    const requestedLimit = Number(request.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : records.length;
    const before = typeof request.query.before === 'string' ? request.query.before : '';
    const beforeIndex = before ? records.findIndex((record) => record.info.id === before) : -1;
    const end = beforeIndex >= 0 ? beforeIndex : records.length;
    const start = Math.max(0, end - limit);
    const page = records.slice(start, end);
    const pageIds = new Set(page.map((record) => record.info.id));
    const parentIds = new Set(page
      .map((record) => record.info.parentID)
      .filter((parentId) => typeof parentId === 'string' && parentId && !pageIds.has(parentId)));
    const parentRecords = parentIds.size
      ? records.slice(0, start).filter((record) => parentIds.has(record.info.id))
      : [];
    if (start > 0) response.setHeader('x-next-cursor', records[start].info.id);
    response.json([...parentRecords, ...page].map((record) => ({
      info: record.info,
      parts: record.parts.map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'directory'))),
    })));
  });

  app.post('/session/:sessionID/prompt_async', async (request, response) => {
    const session = await store.getSession(request.params.sessionID);
    if (!session) return response.status(404).json({ error: 'Session not found.' });
    if (supervisor.isRunning(session.id)) return response.status(409).json({ error: 'Session is already running.' });
    const prompt = extractPrompt(request.body?.parts);
    if (!prompt) return response.status(400).json({ error: 'Message must include text or a file.' });
    const providerId = request.body?.model?.providerID || 'deepseek';
    const modelId = request.body?.model?.modelID || PROVIDER_DEFINITIONS[providerId]?.models?.[0] || 'deepseek-chat';
    const configuredProvider = await providerSettings(providerId, modelId);
    if (!configuredProvider.apiKey) {
      return response.status(401).json({
        error: { name: 'ProviderAuthError', data: { providerID: providerId, message: `Configure a ${providerId} API key first.` } },
      });
    }
    const messageId = request.body?.messageID || createId('msg');
    const now = Date.now();
    const user = {
      id: messageId,
      sessionID: session.id,
      role: 'user',
      time: { created: now },
      agent: request.body?.agent || 'build',
      model: { providerID: providerId, modelID: modelId, ...(request.body?.variant ? { variant: request.body.variant } : {}) },
    };
    const userParts = (request.body?.parts ?? []).map((part) => ({ ...part, id: part.id || createId('part'), sessionID: session.id, messageID: messageId }));
    let updatedSession = session;
    await store.mutate((state) => {
      state.messages[session.id] ??= [];
      state.messages[session.id].push({ info: user, parts: userParts });
      const stored = state.sessions.find((item) => item.id === session.id);
      if (stored) {
        stored.title = stored.title === 'New session' ? sessionTitleFromPrompt(prompt) : stored.title;
        stored.model = { id: modelId, providerID: providerId, ...(request.body?.variant ? { variant: request.body.variant } : {}) };
        stored.agent = request.body?.agent || 'build';
        stored.time.updated = now;
        updatedSession = { ...stored };
      }
    });
    publish(session.directory, event('message.updated', { sessionID: session.id, info: user }));
    for (const part of userParts) publish(session.directory, event('message.part.updated', { sessionID: session.id, part, time: now }));
    publish(session.directory, event('session.updated', { sessionID: session.id, info: updatedSession }));
    response.json(true);
    void startRun({
      session: updatedSession,
      parentMessageId: messageId,
      providerId,
      modelId,
      request: {
        action: 'run',
        prompt,
        appendSystemPrompt: getAgentConfig(request.body?.agent || 'build', session.directory).config?.prompt,
      },
    });
  });
  app.post('/session/:sessionID/abort', async (request, response) => {
    const session = await store.getSession(request.params.sessionID);
    if (!session) return response.status(404).json({ error: 'Session not found.' });
    const stopped = supervisor.abort(session.id);
    if (!stopped) await setStatus(session.id, session.directory, { type: 'idle' });
    return response.json(true);
  });

  app.get('/permission', async (request, response) => {
    const directory = request.query.directory ? normalizeDirectory(request.query.directory) : null;
    response.json((await store.getPermissions(directory)).map(({ directory: _directory, ...item }) => item));
  });
  app.post('/permission/:requestID/reply', async (request, response) => {
    const continuation = await resolveInterrupt({ requestId: request.params.requestID, reply: request.body?.reply || 'reject' });
    if (!continuation) return response.status(404).json({ error: 'Permission request not found.' });
    publish(continuation.directory, event('permission.replied', {
      sessionID: continuation.sessionId,
      requestID: request.params.requestID,
      reply: request.body?.reply || 'reject',
    }));
    return response.json(true);
  });
  app.get('/question', async (request, response) => {
    const directory = request.query.directory ? normalizeDirectory(request.query.directory) : null;
    response.json((await store.getQuestions(directory)).map(({ directory: _directory, _fe_interruptId, _fe_actionId, ...item }) => item));
  });
  app.post('/question/:requestID/reply', async (request, response) => {
    const continuation = await resolveInterrupt({ requestId: request.params.requestID, reply: 'once', answers: request.body?.answers ?? [] });
    if (!continuation) return response.status(404).json({ error: 'Question request not found.' });
    publish(continuation.directory, event('question.replied', {
      sessionID: continuation.sessionId,
      requestID: request.params.requestID,
      answers: request.body?.answers ?? [],
    }));
    return response.json(true);
  });
  app.post('/question/:requestID/reject', async (request, response) => {
    const continuation = await resolveInterrupt({ requestId: request.params.requestID, reply: 'reject', answers: [] });
    if (!continuation) return response.status(404).json({ error: 'Question request not found.' });
    publish(continuation.directory, event('question.rejected', {
      sessionID: continuation.sessionId,
      requestID: request.params.requestID,
    }));
    return response.json(true);
  });

  app.get('/file', async (request, response, next) => {
    try {
      const target = resolveUnderDirectory(request.query.directory, request.query.path || '.');
      const entries = await fs.readdir(target.absolute, { withFileTypes: true });
      response.json(entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => ({
          name: entry.name,
          path: path.posix.join(target.relative.replaceAll(path.sep, '/'), entry.name).replace(/^\.\//, ''),
          absolute: path.join(target.absolute, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file',
          ignored: false,
        })));
    } catch (error) { next(error); }
  });
  app.get('/file/content', async (request, response, next) => {
    try {
      const target = resolveUnderDirectory(request.query.directory, request.query.path);
      const content = await fs.readFile(target.absolute);
      if (content.includes(0)) {
        response.json({ type: 'binary', content: content.toString('base64'), encoding: 'base64' });
      } else {
        response.json({ type: 'text', content: content.toString('utf8') });
      }
    } catch (error) { next(error); }
  });

  app.get('/vcs', async (request, response) => {
    const directory = normalizeDirectory(request.query.directory);
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: directory, timeout: 3000 });
      response.json({ branch: stdout.trim() });
    } catch {
      response.json({ branch: '' });
    }
  });
  app.get('/vcs/status', async (request, response, next) => {
    try { response.json(await gitStatus(normalizeDirectory(request.query.directory))); } catch (error) { next(error); }
  });
  app.get('/vcs/diff', async (request, response, next) => {
    try { response.json(await gitDiff(normalizeDirectory(request.query.directory))); } catch (error) { next(error); }
  });
  app.get('/vcs/diff/raw', async (request, response, next) => {
    try {
      const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--'], { cwd: normalizeDirectory(request.query.directory), timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
      response.type('text/plain').send(stdout);
    } catch (error) { next(error); }
  });
  app.get('/file/status', async (request, response, next) => {
    try {
      response.json((await gitStatus(normalizeDirectory(request.query.directory))).map(({ file, additions, deletions, status }) => ({
        path: file, added: additions, removed: deletions, status,
      })));
    } catch (error) { next(error); }
  });

  app.use((error, _request, response, _next) => {
    logger.error?.('[HaoCode compat]', error);
    response.status(error?.status || 500).json({ error: error?.message || 'HaoCode compatibility server failed.' });
  });

  const start = async () => {
    if (listeningPort) return listeningPort;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    listeningPort = typeof address === 'object' && address ? address.port : null;
    if (!listeningPort) throw new Error('HaoCode compatibility server did not receive a port.');
    logger.log?.(`[HaoCode] Compatibility server listening on 127.0.0.1:${listeningPort}`);
    return listeningPort;
  };

  const stop = async () => {
    const closePromise = listeningPort
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    await supervisor.stopAll();
    await Promise.allSettled([...activeRuns]);
    await store.flush();
    for (const response of globalEventClients) response.end();
    for (const clients of directoryEventClients.values()) for (const response of clients) response.end();
    await closePromise;
    listeningPort = null;
  };

  return {
    start,
    stop,
    getPort: () => listeningPort,
    store,
    supervisor,
  };
};
