import { describe, expect, test } from 'bun:test';

import {
  isOAuthAuthSource,
  normalizeAuthType,
  parseAuthPayload,
  parseOAuthAuthorizePayload,
} from './providerOAuth';

describe('parseAuthPayload', () => {
  test('parses the GET /provider/auth record shape', () => {
    const payload = {
      anthropic: [
        { type: 'api', label: 'Manually enter API Key' },
        { type: 'oauth', label: 'Claude Pro/Max (browser authorization)' },
      ],
      openai: [
        { type: 'api', label: 'Manually enter API Key' },
        { type: 'oauth', label: 'ChatGPT Pro/Plus (browser authorization)' },
      ],
      deepseek: [{ type: 'api', label: 'Manually enter API Key' }],
    };

    const result = parseAuthPayload(payload);
    expect(Object.keys(result).sort()).toEqual(['anthropic', 'deepseek', 'openai']);
    expect(result.anthropic).toHaveLength(2);
    expect(result.deepseek).toHaveLength(1);
  });

  test('drops non-record entries and non-array values', () => {
    const payload = {
      anthropic: [{ type: 'oauth', label: 'x' }, null, 'junk', 42],
      broken: 'not-an-array',
      alsoBroken: { type: 'api' },
    };
    const result = parseAuthPayload(payload);
    expect(result.anthropic).toHaveLength(1);
    expect('broken' in result).toBe(false);
    expect('alsoBroken' in result).toBe(false);
  });

  test('returns an empty record for non-record payloads', () => {
    expect(parseAuthPayload(null)).toEqual({});
    expect(parseAuthPayload(undefined)).toEqual({});
    expect(parseAuthPayload([])).toEqual({});
    expect(parseAuthPayload('nope')).toEqual({});
  });
});

describe('normalizeAuthType', () => {
  test('classifies oauth and api entries from /provider/auth', () => {
    expect(normalizeAuthType({ type: 'oauth', label: 'Claude Pro/Max' })).toBe('oauth');
    expect(normalizeAuthType({ type: 'api', label: 'Manually enter API Key' })).toBe('api');
  });

  test('falls back to label/name matching for untyped entries', () => {
    expect(normalizeAuthType({ label: 'OAuth browser login' })).toBe('oauth');
    expect(normalizeAuthType({ name: 'API key' })).toBe('api');
  });

  test('returns the raw type for unknown entries', () => {
    expect(normalizeAuthType({ type: 'device' })).toBe('device');
    expect(normalizeAuthType({})).toBe('');
  });
});

describe('parseOAuthAuthorizePayload', () => {
  test('parses the direct SDK shape for an auto flow', () => {
    const details = parseOAuthAuthorizePayload({
      url: 'https://auth.example.com/authorize?state=abc',
      method: 'auto',
      instructions: 'Open the link to authorize',
    });
    expect(details).toEqual({
      url: 'https://auth.example.com/authorize?state=abc',
      method: 'auto',
      instructions: 'Open the link to authorize',
      userCode: undefined,
    });
  });

  test('parses a code flow and defaults method to code when absent', () => {
    const details = parseOAuthAuthorizePayload({
      url: 'https://claude.ai/oauth/authorize',
      method: 'code',
      instructions: 'Paste the code back',
    });
    expect(details?.method).toBe('code');

    const defaulted = parseOAuthAuthorizePayload({ url: 'https://example.com' });
    expect(defaulted?.method).toBe('code');
  });

  test('unwraps a nested data envelope', () => {
    const details = parseOAuthAuthorizePayload({
      data: { url: 'https://example.com/auth', method: 'auto' },
    });
    expect(details?.url).toBe('https://example.com/auth');
    expect(details?.method).toBe('auto');
  });

  test('supports device-flow style fields', () => {
    const details = parseOAuthAuthorizePayload({
      verification_uri_complete: 'https://example.com/device?code=ABCD',
      user_code: 'ABCD',
    });
    expect(details?.url).toBe('https://example.com/device?code=ABCD');
    expect(details?.userCode).toBe('ABCD');
  });

  test('returns null when the payload carries nothing actionable', () => {
    expect(parseOAuthAuthorizePayload({})).toBeNull();
    expect(parseOAuthAuthorizePayload(null)).toBeNull();
    expect(parseOAuthAuthorizePayload({ method: 'auto' })).toBeNull();
  });
});

describe('isOAuthAuthSource', () => {
  test('detects oauth-flagged source entries', () => {
    expect(isOAuthAuthSource({ exists: true, type: 'oauth' })).toBe(true);
    expect(isOAuthAuthSource({ exists: true, kind: 'oauth' })).toBe(true);
    expect(isOAuthAuthSource({ exists: true, oauth: true })).toBe(true);
  });

  test('rejects api-key or missing entries', () => {
    expect(isOAuthAuthSource({ exists: true, type: 'api' })).toBe(false);
    expect(isOAuthAuthSource({ exists: false })).toBe(false);
    expect(isOAuthAuthSource(undefined)).toBe(false);
    expect(isOAuthAuthSource(null)).toBe(false);
  });
});
