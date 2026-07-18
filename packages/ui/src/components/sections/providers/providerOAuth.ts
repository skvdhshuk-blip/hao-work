/**
 * Pure helpers for the provider OAuth flow on the Providers settings page.
 *
 * Server/SDK contract (frozen):
 * - GET /provider/auth -> Record<providerId, Array<{ type: 'oauth' | 'api', label: string }>>
 * - POST /provider/:id/oauth/authorize -> { url, method: 'auto' | 'code', instructions? }
 * - POST /provider/:id/oauth/callback body { method, code? } -> boolean
 *   ('code' flows paste the authorization code verbatim, e.g. Anthropic's
 *   `code#state`; the server splits it. 'auto' flows wait server-side for the
 *   browser redirect and need no code.)
 */

import { isRecord } from './providerSettings';

export interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

export type OAuthFlowMethod = 'auto' | 'code';

export interface OAuthAuthorizeDetails {
  url?: string;
  instructions?: string;
  userCode?: string;
  method: OAuthFlowMethod;
}

export const normalizeAuthType = (method: AuthMethod): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

export const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

const pickString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Normalizes the authorize response into UI-ready details. Accepts both the
 * direct SDK shape `{ url, method, instructions }` and a nested `{ data: {...} }`
 * envelope. Returns null when the payload carries nothing actionable.
 */
export const parseOAuthAuthorizePayload = (payload: unknown): OAuthAuthorizeDetails | null => {
  const payloadRecord: Record<string, unknown> = isRecord(payload) ? payload : {};
  const nestedData = payloadRecord.data;
  const dataRecord: Record<string, unknown> = isRecord(nestedData) ? nestedData : payloadRecord;

  const url = pickString(
    dataRecord.url,
    dataRecord.verification_uri_complete,
    dataRecord.verification_uri,
  );
  const instructions = pickString(dataRecord.instructions, dataRecord.message);
  const userCode = pickString(dataRecord.user_code, dataRecord.code, dataRecord.userCode);
  const method: OAuthFlowMethod = dataRecord.method === 'auto' ? 'auto' : 'code';

  if (!url && !instructions && !userCode) {
    return null;
  }
  return { url, instructions, userCode, method };
};

/**
 * Defensive check on the `/provider/:id/source` auth entry: the server may
 * flag OAuth-backed credentials via `type`/`kind` or a boolean `oauth` flag.
 */
export const isOAuthAuthSource = (source: unknown): boolean => {
  if (!isRecord(source)) {
    return false;
  }
  if (source.oauth === true) {
    return true;
  }
  const kind = pickString(source.type, source.kind);
  return kind?.toLowerCase() === 'oauth';
};
