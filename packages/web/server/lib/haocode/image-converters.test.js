import { expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

import { createImageConverters } from './image-converters.js';

const dataUri = 'data:image/png;base64,AA==';
const dataDir = path.join(os.tmpdir(), 'hao-work-image-converters-test');

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('official OpenAI VLM requests include the v1 API prefix', async () => {
  const calls = [];
  const converters = createImageConverters({
    dataDir,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ choices: [{ message: { content: '  一张测试图片  ' } }] });
    },
  });

  const text = await converters.vlm(dataUri, {
    apiKey: 'secret',
    baseUrl: 'https://api.openai.com',
    providerType: 'openai',
    model: 'gpt-4.1',
  });

  expect(text).toBe('一张测试图片');
  expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
  expect(calls[0].init.headers.authorization).toBe('Bearer secret');
});

test('OpenAI URLs that already include v1 are not duplicated', async () => {
  let requestedUrl = '';
  const converters = createImageConverters({
    dataDir,
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
  });

  await converters.vlm(dataUri, {
    apiKey: 'secret',
    baseUrl: 'https://gateway.example/openai/v1/',
    providerType: 'openai',
    model: 'vision-model',
  });

  expect(requestedUrl).toBe('https://gateway.example/openai/v1/chat/completions');
});

test('OpenAI-compatible provider roots are preserved', async () => {
  let requestedUrl = '';
  const converters = createImageConverters({
    dataDir,
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: '描述' }] } }] });
    },
  });

  const text = await converters.vlm(dataUri, {
    apiKey: 'secret',
    baseUrl: 'https://api.deepseek.com',
    providerType: 'openai_chat',
    model: 'deepseek-chat',
  });

  expect(text).toBe('描述');
  expect(requestedUrl).toBe('https://api.deepseek.com/chat/completions');
});

test('Anthropic URLs use exactly one v1 segment', async () => {
  const requestedUrls = [];
  const converters = createImageConverters({
    dataDir,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return jsonResponse({ content: [{ type: 'text', text: '图片内容' }] });
    },
  });

  for (const baseUrl of ['https://api.anthropic.com', 'https://gateway.example/anthropic/v1/']) {
    const text = await converters.vlm(dataUri, {
      apiKey: 'secret',
      baseUrl,
      providerType: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(text).toBe('图片内容');
  }

  expect(requestedUrls).toEqual([
    'https://api.anthropic.com/v1/messages',
    'https://gateway.example/anthropic/v1/messages',
  ]);
});

test('VLM requests settle at the configured timeout even if fetch ignores abort', async () => {
  const converters = createImageConverters({
    dataDir,
    vlmRequestTimeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });

  await expect(converters.vlm(dataUri, {
    apiKey: 'secret',
    baseUrl: 'https://api.openai.com',
    providerType: 'openai',
    model: 'gpt-4.1',
  })).rejects.toThrow(/VLM request timed out after 10ms/);
});
