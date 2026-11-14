import { describe, expect, test } from 'bun:test';
import { pickProviderRoute } from './provider-route.js';

const route = {
  enabled: true,
  preferRoute: false,
  strategy: 'order',
  cursor: 0,
  members: [
    { providerID: 'openai', modelID: 'gpt-5', priority: 1 },
    { providerID: 'deepseek', modelID: 'deepseek-v4-flash', priority: 5 },
  ],
};

describe('pickProviderRoute', () => {
  test('keeps the chat model when it already has a key', () => {
    const picked = pickProviderRoute({
      route,
      requested: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      available: new Set(['deepseek', 'openai']),
    });
    expect(picked.choice).toEqual({ providerID: 'deepseek', modelID: 'deepseek-chat' });
  });

  test('walks the list when the chat model has no key', () => {
    const picked = pickProviderRoute({
      route,
      requested: { providerID: 'missing', modelID: 'none' },
      available: new Set(['deepseek']),
    });
    expect(picked.choice).toEqual({ providerID: 'deepseek', modelID: 'deepseek-v4-flash' });
  });

  test('priority puts the higher number first', () => {
    const picked = pickProviderRoute({
      route: { ...route, strategy: 'priority', preferRoute: true },
      requested: { providerID: 'openai', modelID: 'gpt-5' },
      available: new Set(['openai', 'deepseek']),
    });
    expect(picked.choice.providerID).toBe('deepseek');
  });
});
