import { describe, expect, test } from 'bun:test';

import { isEngineReady, resolveEngineMode } from './engineMode';

describe('resolveEngineMode', () => {
  test('maps the bundled hao-code engine marker to bundled mode', () => {
    expect(resolveEngineMode({ agentEngine: 'haocode' })).toBe('bundled');
  });

  test('maps a different engine marker to external mode', () => {
    expect(resolveEngineMode({ agentEngine: 'opencode' })).toBe('external');
  });

  test('treats a missing engine marker as external (legacy server snapshot)', () => {
    expect(resolveEngineMode({ openCodeRunning: false })).toBe('external');
  });

  test('treats unusable payloads as unknown', () => {
    expect(resolveEngineMode(null)).toBe('unknown');
    expect(resolveEngineMode(undefined)).toBe('unknown');
    expect(resolveEngineMode('haocode')).toBe('unknown');
  });
});

describe('isEngineReady', () => {
  test('is ready when openCodeRunning is true', () => {
    expect(isEngineReady({ openCodeRunning: true })).toBe(true);
  });

  test('is ready when isOpenCodeReady is true', () => {
    expect(isEngineReady({ isOpenCodeReady: true })).toBe(true);
  });

  test('is not ready otherwise', () => {
    expect(isEngineReady({ openCodeRunning: false, isOpenCodeReady: false })).toBe(false);
    expect(isEngineReady({})).toBe(false);
    expect(isEngineReady(null)).toBe(false);
  });
});
