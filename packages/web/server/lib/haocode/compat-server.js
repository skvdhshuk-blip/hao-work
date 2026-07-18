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

const BUILTIN_PROVIDER_IDS = new Set(Object.keys(PROVIDER_DEFINITIONS));
const PROVIDER_TYPES = new Set(['anthropic', 'openai', 'openai_chat']);

// OAuth login flows (subscription tokens) for the built-in providers that
// support them. Anthropic uses the manual paste-code flow (method 'code');
// OpenAI uses a browser flow with a localhost redirect listener (method
// 'auto'). Client ids are public OAuth client ids and may be overridden via
// environment for gateways or testing.
const OAUTH_FLOWS = Object.freeze({
  anthropic: {
    method: 'code',
    label: 'Claude Pro/Max（浏览器授权）',
    clientIdEnv: 'HAOWORK_OAUTH_ANTHROPIC_CLIENT_ID',
    defaultClientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference',
    extraAuthorizeParams: { code: 'true' },
    instructions: '在打开的浏览器页面中完成授权，复制页面显示的验证码（形如 code#state），粘贴回这里完成登录。',
  },
  openai: {
    method: 'auto',
    label: 'ChatGPT Pro/Plus（浏览器授权）',
    clientIdEnv: 'HAOWORK_OAUTH_OPENAI_CLIENT_ID',
    defaultClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    extraAuthorizeParams: { originator: 'opencode' },
    instructions: '在打开的浏览器页面中完成 ChatGPT 授权；授权成功后浏览器会自动跳回本地页面完成登录。',
  },
});

const OAUTH_CALLBACK_PORTS = Object.freeze(
  Array.from({ length: 11 }, (_unused, index) => 1455 + index),
);
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;

const base64url = (buffer) => buffer
  .toString('base64')
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/, '');

const createPkcePair = () => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

const decodeJwtPayload = (token) => {
  if (typeof token !== 'string') return null;
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const decoded = JSON.parse(Buffer.from(segment.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch {
    return null;
  }
};

const oauthClientId = (flow) => process.env[flow.clientIdEnv] || flow.defaultClientId;

// POST an application/x-www-form-urlencoded OAuth token request and return the
// decoded payload. Any transport error, non-2xx status, or payload without an
// access_token throws so callers can fall back to other credentials.
const postOAuthTokenRequest = async (fetchImpl, url, params) => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    const detail = (payload && (payload.error_description || payload.error)) || `HTTP ${response.status}`;
    throw new Error(`OAuth token request failed: ${detail}`);
  }
  return payload;
};

// Token endpoint payload -> persisted oauth record shape
// { access, refresh, expires (ms epoch), accountId? }. A missing refresh_token
// in a refresh response keeps the previous one (several providers rotate
// access tokens only).
const oauthRecordFromTokenPayload = (payload, previous = null, accountId = null) => ({
  access: payload.access_token,
  refresh: typeof payload.refresh_token === 'string' && payload.refresh_token
    ? payload.refresh_token
    : previous?.refresh ?? null,
  expires: Date.now() + Math.max(1, Number(payload.expires_in) || 3600) * 1000,
  ...(accountId ? { accountId } : (previous?.accountId ? { accountId: previous.accountId } : {})),
});

const slugifyProviderId = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64)
  .replace(/-+$/g, '');

const hasEnvCredential = (definition) => definition.env.some((name) => Boolean(process.env[name]));

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

const modelDefinition = (providerID, id, limit, baseUrl = '') => ({
  id,
  providerID,
  api: { id, url: baseUrl || PROVIDER_DEFINITIONS[providerID]?.baseUrl || '', npm: '' },
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

const HITL_MODES = new Set(['ask', 'smart', 'auto']);

const normalizeHitlMode = (value) => (HITL_MODES.has(value) ? value : 'smart');

const normalizeHitlReviewModel = (value) => (
  typeof value === 'string' && value.trim() ? value : null
);

const AUTO_DECISION_SOURCES = new Set(['rule', 'review', 'sandbox']);
const AUTO_DECISION_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const ESCALATION_SOURCES = new Set(['rule', 'review', 'batch', 'sandbox']);

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

// First tokens too powerful to generalize: commands led by them are persisted
// as exact rules instead of bare prefix rules.
const HITL_ALLOWLIST_EXACT_ONLY_TOOLS = new Set([
  'sudo', 'su', 'doas',
  'python', 'python3', 'node', 'nodejs',
  'bash', 'sh', 'zsh', 'fish',
  'php', 'ruby', 'perl', 'lua',
  'env', 'xargs', 'eval', 'exec', 'source', '.',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  'nc', 'ncat', 'osascript', 'pwsh', 'powershell',
]);

// Tools whose second token names the real operation, so prefix rules keep two
// tokens (three when the second token is a run/exec/dlx wrapper).
const HITL_ALLOWLIST_SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'yarn', 'pnpm', 'bun', 'composer', 'cargo', 'pip', 'pip3',
  'docker', 'kubectl', 'helm', 'go', 'gem', 'brew',
]);
const HITL_ALLOWLIST_WRAPPER_SUBCOMMANDS = new Set(['run', 'exec', 'dlx']);

// Canonical dedup key for an allowlist rule; null for malformed entries.
// Legacy v1 entries carry no type and behave as exact rules.
const hitlAllowlistRuleKey = (rule) => {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.type === 'prefix') {
    if (!Array.isArray(rule.tokens) || !rule.tokens.length) return null;
    if (rule.tokens.some((token) => typeof token !== 'string' || !token)) return null;
    return `prefix:${JSON.stringify(rule.tokens)}`;
  }
  return typeof rule.command === 'string' && rule.command.trim() ? `exact:${rule.command}` : null;
};

// Split a shell command on &&, ||, ;, and | without splitting inside quotes.
// Newlines are not separators here: heredoc commands never reach this splitter
// (they are stored exact), and the SDK applies its own newline splitting.
const splitShellSegments = (command) => {
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote && !(quote === '"' && command[index - 1] === '\\')) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '\\' && index + 1 < command.length) { current += char + command[index + 1]; index += 1; continue; }
    if (char === ';' || char === '|') {
      segments.push(current);
      current = '';
      if (char === '|' && command[index + 1] === '|') index += 1;
      continue;
    }
    if (char === '&' && command[index + 1] === '&') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
};

// Remove leading `VAR=value` environment assignments; the SDK strips them the
// same way before matching, so generated rules must describe what remains.
const stripLeadingEnvAssignments = (segment) => {
  let rest = segment;
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(rest);
    if (!assignment) return rest.trim();
    let index = assignment[0].length;
    while (index < rest.length && !/\s/.test(rest[index])) {
      const char = rest[index];
      if (char === "'" || char === '"') {
        const close = rest.indexOf(char, index + 1);
        index = close === -1 ? rest.length : close + 1;
      } else {
        index += char === '\\' ? 2 : 1;
      }
    }
    rest = rest.slice(index).trimStart();
  }
};

// Whitespace-split a segment and unquote both ends of each token, matching the
// SDK's tokenization for prefix-rule comparison.
const shellSegmentTokens = (segment) => segment
  .split(/\s+/)
  .filter(Boolean)
  .map((token) => token.replace(/^['"]+|['"]+$/g, ''));

// Detect file redirections in a segment: `>`, `>>`, `2>`, or a `tee` token in
// the pipeline. The `2>&1` stderr merge and discards to /dev/null are not file
// redirections; quoted `>` characters are ignored.
const segmentHasFileRedirection = (segment, tokens) => {
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote && !(quote === '"' && segment[index - 1] === '\\')) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\') { index += 1; continue; }
    if (char !== '>') continue;
    if (segment[index - 1] === '2' && segment.slice(index + 1, index + 3) === '&1') continue;
    const target = segment.slice(segment[index + 1] === '>' ? index + 2 : index + 1);
    if (/^\s*\/dev\/null(\s|$)/.test(target)) continue;
    return true;
  }
  return tokens.includes('tee');
};

// Build the SDK v2 allowlist rules for an always-allowed Bash command. Heredoc
// commands and segments that cannot be generalized safely (file redirections,
// path execution, powerful interpreters) stay exact; everything else becomes a
// codex-style prefix rule per shell segment, so `git commit -m x` pre-approves
// later `git commit` invocations without approving unrelated commands.
const buildHitlAllowlistRules = (command) => {
  const trimmed = command.trim();
  if (!trimmed) return [];
  // Heredocs span lines and resist segment generalization; keep exact.
  if (trimmed.includes('<<')) return [{ type: 'exact', command: trimmed }];
  const rules = [];
  const seen = new Set();
  const push = (rule) => {
    const key = hitlAllowlistRuleKey(rule);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };
  for (const rawSegment of splitShellSegments(trimmed)) {
    const segment = stripLeadingEnvAssignments(rawSegment.trim());
    if (!segment) continue;
    const tokens = shellSegmentTokens(segment);
    const first = tokens[0];
    if (!first) continue;
    if (segmentHasFileRedirection(segment, tokens) || first.includes('/') || HITL_ALLOWLIST_EXACT_ONLY_TOOLS.has(first)) {
      push({ type: 'exact', command: segment });
      continue;
    }
    if (HITL_ALLOWLIST_SUBCOMMAND_TOOLS.has(first)) {
      const count = tokens.length >= 3 && HITL_ALLOWLIST_WRAPPER_SUBCOMMANDS.has(tokens[1])
        ? 3
        : Math.min(2, tokens.length);
      push({ type: 'prefix', tokens: tokens.slice(0, count) });
      continue;
    }
    push({ type: 'prefix', tokens: [first] });
  }
  return rules;
};

export const createHaoCodeCompatibilityServer = ({
  dataDir,
  logger = console,
  workerOptions = {},
  modelsMetadataLoader = getModelsMetadata,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  oauthCallbackPorts = OAUTH_CALLBACK_PORTS,
  oauthCallbackTimeoutMs = OAUTH_CALLBACK_TIMEOUT_MS,
}) => {
  const app = express();
  const server = http.createServer(app);
  const store = createHaoCodeStore({ rootDir: path.join(dataDir, 'haocode') });
  const supervisor = createWorkerSupervisor(workerOptions);
  const globalEventClients = new Set();
  const directoryEventClients = new Map();
  const activeRuns = new Set();
  // In-flight OAuth flows keyed by provider id. Anthropic pendings hold the
  // PKCE verifier/state for the paste-code callback; OpenAI pendings also own
  // the localhost redirect listener and the promise the callback route awaits.
  const pendingOAuth = new Map();
  // Single-flight map so concurrent runs share one token refresh per provider.
  const oauthRefreshInflight = new Map();
  // Smart-mode escalation reasons waiting for their interrupt to arrive,
  // keyed by `${interruptId}:${actionId}`.
  const pendingEscalations = new Map();
  let haoCodeVersionPromise = null;
  let eventSequence = 0;
  let listeningPort = null;

  // Persistent user allowlist behind PermissionCard "Always Allow". Every
  // worker request carries this path as `hitlAllowlistPath`; the SDK matches
  // trimmed Bash commands from it before rule grading, so a persisted rule
  // pre-approves the command on later runs. Format (v2):
  // { "version": 2, "rules": [
  //   { "type": "prefix", "tokens": [...], "addedAt", "source": "user" },
  //   { "type": "exact", "command": "...", "addedAt", "source": "user" },
  // ] }.
  // Legacy v1 entries ({ "command", ... } with no type) are kept unchanged and
  // behave as exact rules.
  const hitlAllowlistPath = path.join(store.rootDir, 'hitl-allowlist.json');
  let hitlAllowlistQueue = Promise.resolve();

  // Read-modify-write the allowlist file, serialized like the other state
  // writes so concurrent replies cannot interleave. A missing or corrupted
  // file is rebuilt from an empty rule list; rules are deduped by type and
  // content (tokens array for prefix rules, command string for exact rules,
  // v1 entries counting as exact). When every generated rule is already
  // persisted the file is left untouched.
  const appendHitlAllowlistRule = (command) => {
    const additions = buildHitlAllowlistRules(command);
    if (!additions.length) return Promise.resolve(false);
    const write = hitlAllowlistQueue.then(async () => {
      let rules = [];
      try {
        const decoded = JSON.parse(await fs.readFile(hitlAllowlistPath, 'utf8'));
        if (decoded && typeof decoded === 'object' && (decoded.version === 1 || decoded.version === 2) && Array.isArray(decoded.rules)) {
          rules = decoded.rules.filter((rule) => hitlAllowlistRuleKey(rule) !== null);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger.warn?.(`[HaoCode compat] Rebuilding unreadable HITL allowlist: ${error.message}`);
        }
      }
      const seen = new Set(rules.map((rule) => hitlAllowlistRuleKey(rule)));
      const pending = additions.filter((rule) => !seen.has(hitlAllowlistRuleKey(rule)));
      if (!pending.length) return false;
      const addedAt = new Date().toISOString();
      rules.push(...pending.map((rule) => ({ ...rule, addedAt, source: 'user' })));
      await fs.mkdir(path.dirname(hitlAllowlistPath), { recursive: true, mode: 0o700 });
      const temporary = `${hitlAllowlistPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 2, rules }, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, hitlAllowlistPath);
      } finally {
        try {
          await fs.rm(temporary, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      return true;
    });
    // Keep the queue alive after a failed write while surfacing the real
    // failure to this caller.
    hitlAllowlistQueue = write.catch(() => {});
    return write;
  };

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

  // Merged provider registry: built-in definitions plus user-defined custom
  // providers persisted in state.customProviders. Persisted entries are
  // validated on write, but normalize defensively so a hand-edited state file
  // cannot break the listing.
  const providerDefinitions = async () => {
    const custom = await store.read((state) => state.customProviders ?? {});
    const definitions = {};
    for (const [id, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
      definitions[id] = {
        name: definition.name,
        providerType: definition.providerType,
        baseUrl: definition.baseUrl,
        env: [definition.env],
        models: [...definition.models],
        custom: false,
      };
    }
    for (const [id, definition] of Object.entries(custom)) {
      if (!definition || typeof definition !== 'object') continue;
      definitions[id] = {
        name: typeof definition.name === 'string' && definition.name ? definition.name : id,
        providerType: PROVIDER_TYPES.has(definition.providerType) ? definition.providerType : 'openai_chat',
        baseUrl: typeof definition.baseUrl === 'string' ? definition.baseUrl : '',
        env: [],
        models: Array.isArray(definition.models) ? definition.models.filter((model) => typeof model === 'string' && model) : [],
        custom: true,
        contextWindow: positiveInteger(definition.contextWindow) ?? undefined,
        maxTokens: positiveInteger(definition.maxTokens) ?? undefined,
      };
    }
    return definitions;
  };

  // Custom providers keep their creation-time limits on the definition;
  // per-provider PATCH overrides live in state.providers and win when set.
  const limitSourceFor = (definition, saved) => (definition.custom
    ? { contextWindow: definition.contextWindow, maxTokens: definition.maxTokens, ...saved }
    : saved);

  const buildProviderEntry = ({ id, definition, saved, metadata }) => {
    const baseUrl = saved.baseUrl || definition.baseUrl;
    const models = [...new Set([...(definition.models ?? []), ...(Array.isArray(saved.models) ? saved.models : [])])];
    return {
      id,
      name: definition.name,
      source: saved.apiKey || saved.oauth?.access || hasEnvCredential(definition) ? 'api' : 'custom',
      env: definition.env,
      options: {
        baseURL: baseUrl,
        _fe_providerType: saved.providerType || definition.providerType,
      },
      models: Object.fromEntries(models.map((model) => [model, modelDefinition(
        id,
        model,
        resolveModelLimit({ metadata, providerId: id, modelId: model, saved: limitSourceFor(definition, saved) }),
        baseUrl,
      )])),
    };
  };

  const listProviders = async () => {
    const metadata = await loadModelsMetadata();
    const definitions = await providerDefinitions();
    const providers = await Promise.all(Object.entries(definitions).map(async ([id, definition]) => buildProviderEntry({
      id,
      definition,
      saved: await store.getProviderSettings(id),
      metadata,
    })));
    return {
      providers,
      connected: providers.filter((provider) => provider.source === 'api').map((provider) => provider.id),
      defaults: Object.fromEntries(providers
        .map((provider) => [provider.id, Object.keys(provider.models)[0]])
        .filter(([, model]) => Boolean(model))),
    };
  };

  const providerSettingsResponse = async (providerId, definition) => {
    const saved = await store.getProviderSettings(providerId);
    return {
      providerId,
      baseUrl: saved.baseUrl || definition.baseUrl,
      providerType: saved.providerType || definition.providerType,
      models: Array.isArray(saved.models) ? saved.models : [],
      contextWindow: positiveInteger(saved.contextWindow) ?? (definition.custom ? positiveInteger(definition.contextWindow) : null),
      maxTokens: positiveInteger(saved.maxTokens) ?? (definition.custom ? positiveInteger(definition.maxTokens) : null),
      _fe_agentEngine: 'haocode',
    };
  };

  // --- OAuth login flows ---------------------------------------------------

  const getPendingOAuth = (providerId) => {
    const pending = pendingOAuth.get(providerId);
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
      cancelPendingOAuth(providerId);
      return null;
    }
    return pending;
  };

  function cancelPendingOAuth(providerId, result = { error: 'OAuth flow was cancelled.' }) {
    const pending = pendingOAuth.get(providerId);
    if (!pending) return;
    pendingOAuth.delete(providerId);
    clearTimeout(pending.timeout);
    if (pending.resolveWait) pending.resolveWait(result);
    if (pending.server) {
      try { pending.server.close(); } catch { /* listener already closed */ }
    }
  }

  // Start the localhost redirect listener for the OpenAI browser flow. Ports
  // are tried in order (1455-1465 by default) so a busy port falls through;
  // port 0 in the list binds an ephemeral port (used by tests).
  const startOAuthCallbackListener = async (providerId) => {
    let lastError = null;
    for (const candidate of oauthCallbackPorts) {
      const listener = http.createServer((incoming, outgoing) => {
        const url = new URL(incoming.url ?? '/', 'http://localhost');
        const result = {
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          error: url.searchParams.get('error_description') || url.searchParams.get('error'),
        };
        // Route the redirect to the pending flow whose state matches; fall
        // back to this provider's pending so a state mismatch surfaces as a
        // validation error instead of a hung callback.
        const pending = [...pendingOAuth.values()].find((entry) => entry.flow === 'openai' && entry.state === result.state)
          ?? pendingOAuth.get(providerId);
        if (pending?.resolveWait) {
          clearTimeout(pending.timeout);
          pending.resolveWait(result);
        }
        outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        outgoing.end(`<!doctype html><html><head><meta charset="utf-8"><title>Hao Work</title></head><body style="font-family:system-ui;padding:2rem"><h2>${result.error ? '授权失败' : '授权完成'}</h2><p>${result.error ? '浏览器授权未完成，请返回应用重试。' : '登录已完成，可以关闭此页面并返回应用。'}</p></body></html>`);
      });
      try {
        await new Promise((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(candidate, '127.0.0.1', resolve);
        });
        const address = listener.address();
        return { server: listener, port: typeof address === 'object' && address ? address.port : candidate };
      } catch (error) {
        lastError = error;
        try { listener.close(); } catch { /* not listening */ }
      }
    }
    throw new Error(`Unable to start the OAuth callback listener: ${lastError?.message || 'no port available'}`);
  };

  const beginAnthropicOAuth = (providerId, flow) => {
    const { verifier, challenge } = createPkcePair();
    // Anthropic convention: the OAuth state doubles as the PKCE verifier, and
    // the page shows "<code>#<state>" for the user to paste back.
    const state = verifier;
    pendingOAuth.set(providerId, {
      flow: 'anthropic',
      verifier,
      state,
      expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
    });
    const url = new URL(flow.authorizeUrl);
    for (const [key, value] of Object.entries(flow.extraAuthorizeParams)) url.searchParams.set(key, value);
    url.searchParams.set('client_id', oauthClientId(flow));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', flow.redirectUri);
    url.searchParams.set('scope', flow.scope);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return { url: url.toString(), method: flow.method, instructions: flow.instructions };
  };

  const beginOpenAiOAuth = async (providerId, flow) => {
    cancelPendingOAuth(providerId);
    const { server: listener, port } = await startOAuthCallbackListener(providerId);
    const { verifier, challenge } = createPkcePair();
    const state = base64url(crypto.randomBytes(16));
    let resolveWait;
    const wait = new Promise((resolve) => { resolveWait = resolve; });
    const timeout = setTimeout(() => {
      resolveWait({ error: 'Timed out waiting for the browser to finish authorization.' });
    }, oauthCallbackTimeoutMs);
    timeout.unref?.();
    const redirectUri = `http://localhost:${port}/auth/callback`;
    pendingOAuth.set(providerId, {
      flow: 'openai',
      verifier,
      state,
      redirectUri,
      server: listener,
      wait,
      resolveWait,
      timeout,
      expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
    });
    const url = new URL(flow.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oauthClientId(flow));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', flow.scope);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    for (const [key, value] of Object.entries(flow.extraAuthorizeParams)) url.searchParams.set(key, value);
    return { url: url.toString(), method: flow.method, instructions: flow.instructions };
  };

  const completeAnthropicOAuth = async (providerId, flow, rawCode) => {
    const pending = getPendingOAuth(providerId);
    if (!pending || pending.flow !== 'anthropic') {
      throw Object.assign(new Error('No Anthropic OAuth flow is in progress; start authorization first.'), { status: 400 });
    }
    if (!rawCode) {
      throw Object.assign(new Error('Paste the authorization code shown in the browser.'), { status: 400 });
    }
    const [code, providedState] = rawCode.split('#');
    if (!code) {
      throw Object.assign(new Error('The pasted value does not look like an authorization code.'), { status: 400 });
    }
    if (providedState && providedState !== pending.state) {
      throw Object.assign(new Error('The pasted code does not match the pending authorization (state mismatch); start over.'), { status: 400 });
    }
    const payload = await postOAuthTokenRequest(fetchImpl, flow.tokenUrl, {
      grant_type: 'authorization_code',
      client_id: oauthClientId(flow),
      code,
      state: providedState || pending.state,
      redirect_uri: flow.redirectUri,
      code_verifier: pending.verifier,
    });
    pendingOAuth.delete(providerId);
    return oauthRecordFromTokenPayload(payload);
  };

  const completeOpenAiOAuth = async (providerId, flow) => {
    const pending = getPendingOAuth(providerId);
    if (!pending || pending.flow !== 'openai') {
      throw Object.assign(new Error('No OpenAI OAuth flow is in progress; start authorization first.'), { status: 400 });
    }
    let result;
    try {
      result = await pending.wait;
    } finally {
      cancelPendingOAuth(providerId);
    }
    if (result?.error || !result?.code) {
      throw Object.assign(new Error(`OpenAI authorization failed: ${result?.error || 'no code returned'}`), { status: 400 });
    }
    if (result.state !== pending.state) {
      throw Object.assign(new Error('The browser redirect does not match the pending authorization (state mismatch); start over.'), { status: 400 });
    }
    const payload = await postOAuthTokenRequest(fetchImpl, flow.tokenUrl, {
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: pending.redirectUri,
      client_id: oauthClientId(flow),
      code_verifier: pending.verifier,
    });
    const accountId = decodeJwtPayload(payload.id_token)?.chatgpt_account_id
      ?? decodeJwtPayload(payload.access_token)?.chatgpt_account_id
      ?? null;
    return oauthRecordFromTokenPayload(payload, null, typeof accountId === 'string' && accountId ? accountId : null);
  };

  const storeOAuthRecord = async (providerId, record) => {
    await store.mutate((state) => {
      const entry = state.providers[providerId] ?? {};
      entry.oauth = record;
      state.providers[providerId] = entry;
    });
  };

  // Refresh a near-expiry oauth record through the provider's refresh_token
  // grant. Single-flight per provider so concurrent runs share one request.
  // Returns the fresh access token, or null when the refresh failed (callers
  // then fall back to a saved apiKey or environment credentials).
  const refreshOAuthTokens = (providerId, flow) => {
    const inflight = oauthRefreshInflight.get(providerId);
    if (inflight) return inflight;
    const task = (async () => {
      const saved = await store.getProviderSettings(providerId);
      const oauth = saved.oauth;
      if (!oauth?.refresh) return null;
      try {
        const payload = await postOAuthTokenRequest(fetchImpl, flow.tokenUrl, {
          grant_type: 'refresh_token',
          refresh_token: oauth.refresh,
          client_id: oauthClientId(flow),
        });
        const record = oauthRecordFromTokenPayload(payload, oauth);
        await store.mutate((state) => {
          const entry = state.providers[providerId] ?? {};
          // Only write back when the stored refresh token is still the one we
          // used, so a concurrent fresh login is never clobbered.
          if (entry.oauth?.refresh === oauth.refresh) entry.oauth = record;
          state.providers[providerId] = entry;
        });
        return record.access;
      } catch (error) {
        logger.warn?.(`[HaoCode compat] OAuth token refresh for ${providerId} failed: ${error.message}`);
        return null;
      }
    })();
    oauthRefreshInflight.set(providerId, task);
    try {
      return task;
    } finally {
      task.finally(() => {
        if (oauthRefreshInflight.get(providerId) === task) oauthRefreshInflight.delete(providerId);
      });
    }
  };

  // Credential resolution order for a provider with a stored oauth record:
  // a non-expiring access token is used directly; a token within the 5-minute
  // expiry skew is refreshed synchronously first; any failure falls through
  // to null so the caller can use saved.apiKey / environment credentials.
  const resolveOAuthAccessToken = async (providerId) => {
    const flow = OAUTH_FLOWS[providerId];
    if (!flow) return null;
    const saved = await store.getProviderSettings(providerId);
    const oauth = saved.oauth;
    if (!oauth || typeof oauth.access !== 'string' || !oauth.access) return null;
    const expires = Number(oauth.expires) || 0;
    if (expires - Date.now() > OAUTH_REFRESH_SKEW_MS) return oauth.access;
    if (typeof oauth.refresh === 'string' && oauth.refresh) {
      return refreshOAuthTokens(providerId, flow);
    }
    return expires > Date.now() ? oauth.access : null;
  };

  const providerSettings = async (providerId, requestedModel) => {
    const definitions = await providerDefinitions();
    const definition = definitions[providerId] ?? definitions.deepseek;
    const saved = await store.getProviderSettings(providerId);
    const model = requestedModel || saved.model || definition.models[0];
    const limit = resolveModelLimit({
      metadata: await loadModelsMetadata(),
      providerId,
      modelId: model,
      saved: limitSourceFor(definition, saved),
    });
    // Credential resolution order: oauth access token (refreshed when near
    // expiry) -> saved apiKey -> environment variable. Anthropic OAuth access
    // tokens are Bearer credentials rather than x-api-key keys, so the worker
    // request marks them with oauthBearer.
    const oauthAccess = await resolveOAuthAccessToken(providerId);
    return {
      apiKey: oauthAccess || saved.apiKey || definition.env.map((name) => process.env[name]).find(Boolean) || null,
      baseUrl: saved.baseUrl || definition.baseUrl,
      providerType: saved.providerType || definition.providerType,
      model,
      contextWindow: limit.context,
      maxTokens: limit.output,
      ...(oauthAccess && providerId === 'anthropic' ? { oauthBearer: true } : {}),
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

  // Map an interrupted tool action to the permission fields the UI renders.
  // The command/path must live in `patterns` AND flattened `metadata` — the
  // card's tool-specific layouts read top-level metadata.command / .file_path,
  // not the nested input object.
  const buildPermissionFields = (action, interruptId, escalation = null) => {
    const toolName = action.tool_name || 'tool';
    const input = action.input && typeof action.input === 'object' ? action.input : {};
    const description = action.description ?? '';
    let pattern = null;
    if (toolName === 'Bash' && typeof input.command === 'string' && input.command.trim().length > 0) {
      pattern = input.command;
    } else if (
      (toolName === 'Write' || toolName === 'Edit' || toolName === 'apply_patch' || toolName === 'MultiEdit')
    ) {
      const filePath = input.file_path ?? input.path ?? input.filePath;
      if (typeof filePath === 'string' && filePath.length > 0) pattern = filePath;
    }
    return {
      permission: toolName,
      patterns: [pattern ?? description ?? toolName ?? 'Tool execution'],
      metadata: {
        ...input,
        input,
        description,
        _fe_interruptId: interruptId,
        _fe_actionId: action.id,
        ...(escalation ? {
          _fe_escalationReason: escalation.reason,
          _fe_escalationSource: escalation.source,
          _fe_escalationRisk: escalation.riskLevel,
        } : {}),
      },
    };
  };

  const createPendingInterrupts = async ({ session, assistantId, interrupt }) => {
    const actions = Array.isArray(interrupt?.actions) ? interrupt.actions : [];
    // Claim any smart-mode escalation reasons stashed for this interrupt's
    // actions so both the stored permission and the SSE payload see them.
    const escalations = new Map();
    for (const action of actions) {
      const key = `${interrupt.id}:${action.id}`;
      if (pendingEscalations.has(key)) {
        escalations.set(action.id, pendingEscalations.get(key));
        pendingEscalations.delete(key);
      }
    }
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
            ...buildPermissionFields(action, interrupt.id, escalations.get(action.id) ?? null),
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
          ...buildPermissionFields(action, interrupt.id, escalations.get(action.id) ?? null),
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
      if (message.type === 'auto_decision') {
        // Smart-mode worker auto-resolved one action and continues in-process.
        // This is an audit/visibility event only; it must never create a
        // pending permission or question, and unknown enum values are
        // normalized conservatively (fail-closed display).
        const actionId = typeof message.actionId === 'string' && message.actionId ? message.actionId : 'unknown';
        const interruptId = typeof message.interruptId === 'string' ? message.interruptId : null;
        if (message.decision === 'escalate') {
          // The worker escalated this action to a human; the interrupt itself
          // arrives right after and creates the pending permission. Stash the
          // escalation context so it can be merged into that permission's
          // metadata — never into state.autoDecisions, and never as an SSE
          // permission.auto_resolved (nothing was resolved automatically).
          const source = ESCALATION_SOURCES.has(message.source) ? message.source : 'rule';
          const riskLevel = AUTO_DECISION_RISK_LEVELS.has(message.riskLevel) ? message.riskLevel : 'high';
          const reason = typeof message.reason === 'string' ? message.reason : '';
          if (interruptId && actionId !== 'unknown') {
            pendingEscalations.set(`${interruptId}:${actionId}`, { reason, source, riskLevel });
            if (pendingEscalations.size > 500) {
              // Bound stale entries whose interrupt never arrived.
              pendingEscalations.delete(pendingEscalations.keys().next().value);
            }
          }
          return;
        }
        const decision = message.decision === 'approve' ? 'approve' : 'reject';
        const source = AUTO_DECISION_SOURCES.has(message.source) ? message.source : 'rule';
        const riskLevel = AUTO_DECISION_RISK_LEVELS.has(message.riskLevel) ? message.riskLevel : 'high';
        const reason = typeof message.reason === 'string' ? message.reason : '';
        const toolName = typeof message.toolName === 'string' && message.toolName ? message.toolName : 'tool';
        const toolInput = message.toolInput && typeof message.toolInput === 'object' ? message.toolInput : {};
        await store.mutate((state) => {
          const records = state.autoDecisions[session.id] ?? [];
          records.push({
            id: createId('auto'),
            sessionId: session.id,
            directory: session.directory,
            interruptId,
            actionId,
            tool: toolName,
            input: toolInput,
            decision,
            source,
            riskLevel,
            reason,
            time: Date.now(),
          });
          state.autoDecisions[session.id] = records.slice(-100);
        });
        publish(session.directory, event('permission.auto_resolved', {
          sessionID: session.id,
          requestID: `req_${actionId}`,
          permission: toolName,
          metadata: {
            input: toolInput,
            description: reason,
            _fe_interruptId: interruptId,
            _fe_actionId: actionId,
            _fe_autoDecision: decision,
            _fe_source: source,
            _fe_riskLevel: riskLevel,
          },
        }));
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
      const hitlConfig = await store.getConfig();
      await supervisor.run({
        sessionId: session.id,
        request: {
          ...request,
          cwd: session.directory,
          storagePath: path.join(dataDir, 'haocode-sdk'),
          provider: await providerSettings(providerId, modelId),
          haocodeSessionId: session.metadata?._fe_haocodeSessionId ?? request.haocodeSessionId ?? null,
          thinkingEnabled: /reason|thinking|r1/i.test(modelId),
          hitlMode: normalizeHitlMode(hitlConfig._fe_hitlMode),
          hitlReviewModel: normalizeHitlReviewModel(hitlConfig._fe_hitlReviewModel),
          hitlAllowlistPath,
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
    let allowlistCommand = null;
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
      // "Always Allow" on a Bash action derives codex-style allowlist rules
      // (prefix where safe, exact otherwise) from the command and persists
      // them into the SDK-facing allowlist so later runs pre-approve matching
      // commands. Non-Bash tools keep the current approve-only behavior
      // (nothing is written).
      if (reply === 'always' && action?.tool_name !== 'AskUserQuestion') {
        const command = pending.metadata?.input?.command;
        if (typeof command === 'string' && command.trim()) allowlistCommand = command.trim();
      }
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
    if (allowlistCommand) {
      try {
        await appendHitlAllowlistRule(allowlistCommand);
      } catch (error) {
        // A failed allowlist write must not block the user's reply; the SDK
        // simply keeps asking until a later always-allow write succeeds.
        logger.warn?.(`[HaoCode compat] Failed to persist HITL allowlist rule: ${error.message}`);
      }
    }
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
    const { providers, defaults } = await listProviders();
    response.json({ providers, default: defaults });
  });
  // SDK provider.list() contract: the same entries as /config/providers plus
  // the ids with usable credentials (saved apiKey or environment variable).
  app.get('/provider', async (_request, response) => {
    const { providers, connected, defaults } = await listProviders();
    response.json({ all: providers, connected, default: defaults });
  });
  app.put('/provider/custom', async (request, response) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return response.status(400).json({ error: 'Provider name is required.' });
    const providerType = typeof body.providerType === 'string' ? body.providerType.trim() : '';
    if (!PROVIDER_TYPES.has(providerType)) return response.status(400).json({ error: 'Unsupported HaoCode provider type.' });
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    let parsedUrl = null;
    try { parsedUrl = new URL(baseUrl); } catch { parsedUrl = null; }
    if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
      return response.status(400).json({ error: 'Base URL must be a valid http or https URL.' });
    }
    const limits = {};
    for (const key of ['contextWindow', 'maxTokens']) {
      if (body[key] === undefined || body[key] === null || body[key] === '') continue;
      const parsed = positiveInteger(body[key]);
      if (parsed === null) return response.status(400).json({ error: `${key} must be a positive integer.` });
      limits[key] = parsed;
    }
    let id;
    if (body.id !== undefined && body.id !== null && String(body.id).trim() !== '') {
      id = String(body.id).trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
        return response.status(400).json({ error: 'Provider id must use lowercase letters, digits, and hyphens.' });
      }
    } else {
      id = slugifyProviderId(name);
      if (!id) return response.status(400).json({ error: 'Provider name must contain letters or digits.' });
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.map((model) => (typeof model === 'string' ? model.trim() : '')).filter(Boolean))]
      : [];

    let conflict = false;
    await store.mutate((state) => {
      state.customProviders ??= {};
      if (BUILTIN_PROVIDER_IDS.has(id) || state.customProviders[id]) {
        conflict = true;
        return;
      }
      state.customProviders[id] = {
        name,
        providerType,
        baseUrl,
        env: [],
        models,
        ...limits,
        createdAt: new Date().toISOString(),
      };
      if (apiKey) state.providers[id] = { ...(state.providers[id] ?? {}), apiKey };
    });
    if (conflict) return response.status(409).json({ error: 'A provider with this id already exists.' });

    const definitions = await providerDefinitions();
    return response.json(buildProviderEntry({
      id,
      definition: definitions[id],
      saved: await store.getProviderSettings(id),
      metadata: await loadModelsMetadata(),
    }));
  });
  app.delete('/provider/custom/:providerID', async (request, response) => {
    const providerId = request.params.providerID;
    if (BUILTIN_PROVIDER_IDS.has(providerId)) {
      return response.status(400).json({ error: 'Built-in providers cannot be removed.' });
    }
    let removed = false;
    await store.mutate((state) => {
      state.customProviders ??= {};
      if (!state.customProviders[providerId]) return;
      delete state.customProviders[providerId];
      delete state.providers[providerId];
      removed = true;
    });
    if (!removed) return response.status(404).json({ error: 'Unknown custom provider.' });
    return response.json({ removed: true });
  });
  // SDK provider.auth() contract: { [providerId]: ProviderAuthMethod[] }.
  // Built-in Anthropic/OpenAI additionally expose one oauth method; DeepSeek
  // and custom providers stay api-key only.
  app.get('/provider/auth', async (_request, response) => {
    const definitions = await providerDefinitions();
    response.json(Object.fromEntries(Object.entries(definitions).map(([id, definition]) => {
      const methods = [{ type: 'api', label: `${definition.name} API key` }];
      const flow = OAUTH_FLOWS[id];
      if (flow && !definition.custom) methods.push({ type: 'oauth', label: flow.label });
      return [id, methods];
    })));
  });
  // SDK provider.oauth.authorize() contract: body { method } ->
  // { url, method: 'auto' | 'code', instructions }. Anthropic starts a manual
  // paste-code flow (PKCE verifier doubles as the OAuth state); OpenAI starts
  // a browser flow with a localhost redirect listener.
  app.post('/provider/:providerID/oauth/authorize', async (request, response) => {
    const providerId = request.params.providerID;
    const flow = OAUTH_FLOWS[providerId];
    const definitions = await providerDefinitions();
    if (!flow || !definitions[providerId] || definitions[providerId].custom) {
      return response.status(400).json({ error: `Provider ${providerId} does not support OAuth login.` });
    }
    try {
      const authorization = providerId === 'anthropic'
        ? beginAnthropicOAuth(providerId, flow)
        : await beginOpenAiOAuth(providerId, flow);
      return response.json(authorization);
    } catch (error) {
      return response.status(400).json({ error: error?.message || 'Failed to start OAuth authorization.' });
    }
  });
  // SDK provider.oauth.callback() contract: body { method, code? } -> boolean.
  // Anthropic expects the pasted "<code>#<state>" (or bare code); OpenAI
  // awaits the localhost browser redirect (no code in the body).
  app.post('/provider/:providerID/oauth/callback', async (request, response) => {
    const providerId = request.params.providerID;
    const flow = OAUTH_FLOWS[providerId];
    const definitions = await providerDefinitions();
    if (!flow || !definitions[providerId] || definitions[providerId].custom) {
      return response.status(400).json({ error: `Provider ${providerId} does not support OAuth login.` });
    }
    try {
      const record = providerId === 'anthropic'
        ? await completeAnthropicOAuth(providerId, flow, typeof request.body?.code === 'string' ? request.body.code.trim() : '')
        : await completeOpenAiOAuth(providerId, flow);
      await storeOAuthRecord(providerId, record);
      return response.json(true);
    } catch (error) {
      return response.status(error?.status || 400).json({ error: error?.message || 'OAuth callback failed.' });
    }
  });
  app.get('/provider/:providerID/source', async (request, response) => {
    const providerId = request.params.providerID;
    const definitions = await providerDefinitions();
    const definition = definitions[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    const saved = await store.getProviderSettings(providerId);
    const authExists = Boolean(saved.apiKey || saved.oauth?.access || hasEnvCredential(definition));
    return response.json({
      providerId,
      sources: {
        auth: { exists: authExists, path: null },
        user: { exists: false, path: null },
        project: { exists: false, path: null },
        custom: {
          exists: Boolean(definition.custom || saved.baseUrl || saved.providerType || saved.models?.length || saved.contextWindow || saved.maxTokens),
          path: path.join(dataDir, 'haocode', 'runtime-state.json'),
        },
      },
      _fe_agentEngine: 'haocode',
    });
  });
  app.get('/provider/:providerID/settings', async (request, response) => {
    const providerId = request.params.providerID;
    const definitions = await providerDefinitions();
    const definition = definitions[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    return response.json(await providerSettingsResponse(providerId, definition));
  });
  app.patch('/provider/:providerID/settings', async (request, response) => {
    const providerId = request.params.providerID;
    const definitions = await providerDefinitions();
    const definition = definitions[providerId];
    if (!definition) return response.status(404).json({ error: 'Unknown provider.' });
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const providerType = typeof body.providerType === 'string' ? body.providerType.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return response.status(400).json({ error: 'Base URL must use http or https.' });
    if (providerType && !PROVIDER_TYPES.has(providerType)) {
      return response.status(400).json({ error: 'Unsupported HaoCode provider type.' });
    }
    // contextWindow/maxTokens: a positive integer overrides the catalog value;
    // null, 0, or '' deletes the override and restores catalog resolution.
    const limitUpdates = {};
    for (const key of ['contextWindow', 'maxTokens']) {
      if (!(key in body)) continue;
      const raw = body[key];
      if (raw === null || raw === '' || Number(raw) === 0) {
        limitUpdates[key] = null;
        continue;
      }
      const parsed = positiveInteger(raw);
      if (parsed === null) return response.status(400).json({ error: `${key} must be a positive integer.` });
      limitUpdates[key] = parsed;
    }
    await store.mutate((state) => {
      const saved = state.providers[providerId] ?? {};
      if (baseUrl) saved.baseUrl = baseUrl;
      else delete saved.baseUrl;
      if (providerType) saved.providerType = providerType;
      else delete saved.providerType;
      if (model) saved.models = [...new Set([...(Array.isArray(saved.models) ? saved.models : []), model])];
      for (const [key, value] of Object.entries(limitUpdates)) {
        if (value === null) delete saved[key];
        else saved[key] = value;
      }
      state.providers[providerId] = saved;
    });
    return response.json(await providerSettingsResponse(providerId, definition));
  });
  app.put('/auth/:providerID', async (request, response) => {
    const providerId = request.params.providerID;
    const definitions = await providerDefinitions();
    if (!definitions[providerId]) return response.status(404).json({ error: 'Unknown provider.' });
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    if (!key) return response.status(400).json({ error: 'API key is required.' });
    await store.mutate((state) => {
      state.providers[providerId] = { ...(state.providers[providerId] ?? {}), apiKey: key };
    });
    return response.json(true);
  });
  app.delete('/auth/:providerID', async (request, response) => {
    cancelPendingOAuth(request.params.providerID);
    await store.mutate((state) => {
      if (state.providers[request.params.providerID]) {
        delete state.providers[request.params.providerID].apiKey;
        delete state.providers[request.params.providerID].oauth;
      }
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
      delete state.autoDecisions[request.params.sessionID];
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
  // Read-only audit trail for smart-mode worker auto decisions. Returns the
  // persisted per-session history (newest last) so the UI can backfill cards
  // after a refresh or reconnect. Directory is stripped like /permission.
  app.get('/auto-decisions', async (request, response) => {
    const sessionID = typeof request.query.sessionID === 'string' ? request.query.sessionID : '';
    if (!sessionID) return response.status(400).json({ error: 'sessionID is required.' });
    const records = await store.getAutoDecisions(sessionID);
    return response.json(records.map(({ directory: _directory, ...item }) => item));
  });
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
    const modelId = request.body?.model?.modelID
      || (await providerDefinitions())[providerId]?.models?.[0]
      || 'deepseek-chat';
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
    for (const providerId of [...pendingOAuth.keys()]) cancelPendingOAuth(providerId);
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
