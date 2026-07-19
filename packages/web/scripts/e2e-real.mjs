// Hao Work real end-to-end smoke: compat-server + real PHP worker + real DeepSeek.
// Usage: DEEPSEEK_E2E_KEY=sk-... bun scripts/e2e-real.mjs   (from packages/web)
import { createHaoCodeCompatibilityServer } from '../server/lib/haocode/compat-server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_KEY = process.env.DEEPSEEK_E2E_KEY;
if (!API_KEY) { console.error('DEEPSEEK_E2E_KEY required'); process.exit(1); }
const mask = (s) => s.replaceAll(API_KEY, 'sk-***');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hao-e2e-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hao-e2e-proj-'));
let runtime = null;
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};
const api = async (method, url, body) => {
  const response = await fetch(`${runtime.baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* html error page */ }
  return { status: response.status, json };
};
const waitFor = async (fn, timeoutMs = 180_000, everyMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last ?? null;
};
const runPrompt = async (sessionId, text, { timeoutMs = 180_000, parts } = {}) => {
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const body = {
    messageID: messageId,
    model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
    agent: 'build',
    parts: parts ?? [{ type: 'text', text }],
  };
  // Wait for any previous run to drain so sequential prompts never hit 409.
  await waitFor(async () => {
    const st = await api('GET', `/session/status?directory=${encodeURIComponent(project)}`);
    const entry = st.json?.[sessionId];
    return !entry || entry.type === 'idle' ? true : null;
  }, 120_000);
  const sent = await api('POST', `/session/${sessionId}/prompt_async?directory=${encodeURIComponent(project)}`, body);
  if (sent.status !== 200) return { ok: false, status: sent.status, error: sent.json };
  // Complete only when the assistant reply *to this message* terminates —
  // older terminal messages in the same session must not satisfy the wait.
  const messages = await waitFor(async () => {
    const list = await api('GET', `/session/${sessionId}/message?directory=${encodeURIComponent(project)}`);
    const arr = list.json ?? [];
    return arr.some((m) => m.info?.role === 'assistant'
      && m.info?.parentID === messageId
      && ['stop', 'error', 'abort'].includes(m.info?.finish)) ? arr : null;
  }, timeoutMs);
  if (!messages) return { ok: false, status: 'timeout' };
  const assistant = messages.find((m) => m.info?.role === 'assistant' && m.info?.parentID === messageId);
  const textParts = (assistant?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  return { ok: assistant?.info?.finish === 'stop', finish: assistant?.info?.finish, error: assistant?.info?.error, text: textParts, messages };
};
const permissionsFor = async (sessionId) => {
  const list = await api('GET', `/permission?directory=${encodeURIComponent(project)}`);
  return (list.json ?? []).filter((p) => p.sessionID === sessionId);
};

console.log('== Hao Work E2E (real worker + real DeepSeek) ==');
console.log('dataDir:', dataDir, '\nproject:', project);

runtime = await createHaoCodeCompatibilityServer({
  dataDir,
  logger: { log() {}, error(...a) { console.error(mask(a.join(' '))); } },
  workerOptions: {
    phpBinary: '/opt/homebrew/bin/php',
    workerPath: path.resolve(process.cwd(), '../haocode-bridge/worker.php'),
  },
});
const port = await runtime.start(0);
runtime.baseUrl = `http://127.0.0.1:${port}`;
console.log('compat-server listening on', runtime.baseUrl);

// ── S1: health & preset catalog ──────────────────────────────────────────────
console.log('\nS1 health + presets');
{
  const health = await api('GET', '/global/health');
  ok('global health up', health.status === 200);
  const providers = await api('GET', '/provider');
  const ids = (providers.json?.all ?? []).map((p) => p.id);
  ok('GET /provider returns all/connected/default', Array.isArray(providers.json?.all) && Array.isArray(providers.json?.connected));
  for (const id of ['anthropic', 'openai', 'deepseek', 'openrouter', 'xai', 'groq', 'mistral', 'moonshot', 'zai', 'qwen', 'together', 'fireworks', 'cerebras', 'huggingface', 'github-copilot']) {
    if (!ids.includes(id)) ok(`preset ${id}`, false); 
  }
  if (failures === 0) ok(`15 presets present`, ids.length >= 15, `${ids.length} providers`);
}

// ── S2: auth + custom provider round trip ────────────────────────────────────
console.log('\nS2 auth + custom provider CRUD');
{
  const auth = await api('PUT', '/auth/deepseek', { type: 'api', key: API_KEY });
  ok('deepseek key saved', auth.status === 200);
  const created = await api('PUT', '/provider/custom', {
    name: 'E2E Gateway', providerType: 'openai_chat', baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat'], contextWindow: 128000, maxTokens: 4096,
  });
  ok('custom provider created', created.status === 200, `id=${created.json?.id ?? '?'}`);
  const settings = await api('GET', '/provider/e2e-gateway/settings');
  ok('definition-level limits visible', settings.json?.contextWindow === 128000 && settings.json?.maxTokens === 4096,
    `cw=${settings.json?.contextWindow} mt=${settings.json?.maxTokens}`);
  const patched = await api('PATCH', '/provider/e2e-gateway/settings', { contextWindow: 64000 });
  ok('override write', patched.status === 200);
  const after = await api('GET', '/provider/e2e-gateway/settings');
  ok('override wins over definition', after.json?.contextWindow === 64000);
  await api('PATCH', '/provider/e2e-gateway/settings', { contextWindow: null });
  const reset = await api('GET', '/provider/e2e-gateway/settings');
  ok('override reset restores definition', reset.json?.contextWindow === 128000);
  const del = await api('DELETE', '/provider/custom/e2e-gateway');
  ok('custom provider deleted', del.status === 200);
}

// ── S3: real conversation end-to-end ─────────────────────────────────────────
console.log('\nS3 real conversation (text, full stack)');
let sessionId;
{
  const created = await api('POST', `/session?directory=${encodeURIComponent(project)}`, { title: 'e2e' });
  ok('session created', created.status === 200);
  sessionId = created.json.id;
  const run = await runPrompt(sessionId, 'Reply with exactly one word: PONG. Do not use any tools.');
  ok('assistant finished with stop', run.ok, `finish=${run.finish} text=${JSON.stringify(run.text?.slice(0, 40))}`);
  ok('real model answered PONG', /pong/i.test(run.text ?? ''), (run.text ?? '').slice(0, 60));
}

// ── S4: smart HITL auto-allow (read-only command, no card) ───────────────────
console.log('\nS4 smart HITL: ls auto-allowed, no permission card');
{
  const run = await runPrompt(sessionId, 'Use the Bash tool to run exactly: ls -la /tmp — then reply DONE.', { timeoutMs: 240_000 });
  ok('run finished', ['stop'].includes(run.finish), `finish=${run.finish}`);
  const cards = await permissionsFor(sessionId);
  ok('no permission card for read-only ls', cards.length === 0, `${cards.length} cards`);
  const audit = await api('GET', `/auto-decisions?sessionID=${sessionId}`);
  const approvals = (audit.json ?? []).filter((d) => d.decision === 'approve');
  ok('auto-approve audit recorded', approvals.length > 0, `${approvals.length} auto-approvals`);
}

// ── S5: red-line escalation with reason, approve, run continues ──────────────
console.log('\nS5 smart HITL: git push escalates with reason, approve once');
{
  const messageId = `msg_${Date.now()}_s5`;
  await api('POST', `/session/${sessionId}/prompt_async?directory=${encodeURIComponent(project)}`, {
    messageID: messageId,
    model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
    agent: 'build',
    parts: [{ type: 'text', text: 'Use the Bash tool to run exactly: git push — then reply DONE.' }],
  });
  const firstCard = await waitFor(async () => (await permissionsFor(sessionId))[0] ?? null, 120_000);
  ok('permission card appeared', Boolean(firstCard), firstCard?.permission ?? '');
  const escalation = firstCard?.metadata?._fe_escalationReason ?? '';
  ok('escalation reason present', escalation.includes('red_line'), escalation.slice(0, 90));

  // Drive approvals until the run truly terminates: the model may retry the
  // failed command, producing follow-up interrupts that also need replies.
  let approvals = 0;
  let finalFinish = null;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const cards = await permissionsFor(sessionId);
    if (cards.length > 0 && approvals < 4) {
      await api('POST', `/permission/${cards[0].id}/reply`, { reply: 'once' });
      approvals++;
      continue;
    }
    const list = await api('GET', `/session/${sessionId}/message?directory=${encodeURIComponent(project)}`);
    const mine = (list.json ?? []).filter((m) => m.info?.role === 'assistant' && m.info?.parentID === messageId);
    const latest = mine.at(-1);
    if (latest?.info?.finish && latest.info.finish !== 'interrupt') { finalFinish = latest.info.finish; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  ok('approvals accepted', approvals >= 1, `${approvals} approved`);
  ok('run continued after approval', ['stop', 'error'].includes(finalFinish), `finish=${finalFinish} approvals=${approvals}`);
}

// ── S6: always-allow prefix persistence ──────────────────────────────────────
console.log('\nS6 always-allow: pip install prefix rule persists');
{
  const runPromise = runPrompt(sessionId, 'Use the Bash tool to run exactly: pip install e2e-fake-pkg-1 — then reply DONE.', { timeoutMs: 240_000 });
  const card = await waitFor(async () => (await permissionsFor(sessionId))[0] ?? null, 120_000);
  ok('pip install produced a card', Boolean(card), card?.metadata?._fe_escalationReason?.slice(0, 70) ?? '');
  await api('POST', `/permission/${card.id}/reply`, { reply: 'always' });
  await runPromise;
  const allowlist = JSON.parse(fs.readFileSync(path.join(dataDir, 'haocode', 'hitl-allowlist.json'), 'utf8'));
  const prefixRule = (allowlist.rules ?? []).find((r) => r.type === 'prefix' && r.tokens?.[0] === 'pip');
  ok('prefix rule [pip, install] persisted', prefixRule?.tokens?.join(' ') === 'pip install', JSON.stringify(allowlist.rules));

  const before = (await permissionsFor(sessionId)).length;
  const run2 = await runPrompt(sessionId, 'Use the Bash tool to run exactly: pip install e2e-fake-pkg-2 — then reply DONE.', { timeoutMs: 240_000 });
  ok('second run finished', ['stop', 'error'].includes(run2.finish), `finish=${run2.finish}`);
  const after = (await permissionsFor(sessionId)).length;
  ok('no new card for same-prefix command', after === before, `cards ${before} → ${after}`);
}

// ── S7: vision pipeline (deepseek rejects at API; error must surface cleanly) ─
console.log('\nS7 vision: images forwarded natively, provider error surfaces cleanly');
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const run = await runPrompt(sessionId, 'What color is this image?', {
    parts: [
      { type: 'text', text: 'What color is this image?' },
      { type: 'file', mime: 'image/png', url: png, filename: 'dot.png' },
    ],
    timeoutMs: 120_000,
  });
  const errText = `${run.error?.data?.message ?? ''} ${run.text ?? ''}`;
  ok('run terminated (no hang/crash)', ['error', 'stop'].includes(run.finish), `finish=${run.finish}`);
  // The fixed resume path now delivers images natively; deepseek-chat's text
  // endpoint rejects the image_url block at the API — the exact proof the
  // multimodal payload reached the wire.
  ok('provider-side image rejection surfaced', /image_url|unknown variant/i.test(errText), errText.slice(0, 110));
}

// ── S8: agent payload binding ────────────────────────────────────────────────
console.log('\nS8 agent payload passthrough (build default)');
{
  const run = await runPrompt(sessionId, 'Reply with exactly: STILL-ALIVE', { timeoutMs: 120_000 });
  ok('default build agent run works', /STILL-ALIVE/i.test(run.text ?? ''), (run.text ?? '').slice(0, 40));
}

console.log(`\n== E2E done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} ==`);
await runtime.stop();
process.exit(failures === 0 ? 0 : 1);
