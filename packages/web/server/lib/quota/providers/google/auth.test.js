import { afterEach, describe, expect, it } from 'vitest';

import { resolveGoogleOAuthClient } from './auth.js';

const ENV_KEYS = [
  'HAOWORK_ANTIGRAVITY_GOOGLE_CLIENT_ID',
  'HAOWORK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET',
  'HAOWORK_GEMINI_GOOGLE_CLIENT_ID',
  'HAOWORK_GEMINI_GOOGLE_CLIENT_SECRET'
];

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('Google OAuth client configuration', () => {
  it('does not ship OAuth client credentials in source', () => {
    expect(resolveGoogleOAuthClient('gemini')).toEqual({ clientId: '', clientSecret: '' });
    expect(resolveGoogleOAuthClient('antigravity')).toEqual({ clientId: '', clientSecret: '' });
  });

  it('reads source-specific credentials from the environment', () => {
    process.env.HAOWORK_GEMINI_GOOGLE_CLIENT_ID = 'gemini-client';
    process.env.HAOWORK_GEMINI_GOOGLE_CLIENT_SECRET = 'gemini-secret';
    process.env.HAOWORK_ANTIGRAVITY_GOOGLE_CLIENT_ID = 'antigravity-client';
    process.env.HAOWORK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = 'antigravity-secret';

    expect(resolveGoogleOAuthClient('gemini')).toEqual({
      clientId: 'gemini-client',
      clientSecret: 'gemini-secret'
    });
    expect(resolveGoogleOAuthClient('antigravity')).toEqual({
      clientId: 'antigravity-client',
      clientSecret: 'antigravity-secret'
    });
  });
});
