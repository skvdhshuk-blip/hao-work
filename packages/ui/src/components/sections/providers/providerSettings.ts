/**
 * Pure helpers for the Providers settings page: provider-list payload parsing,
 * numeric context/output overrides, and custom-provider payload building.
 *
 * Server contract (frozen):
 * - GET /provider -> { all: [...], connected: [...ids], default: {...} }
 * - PUT /provider/custom body { id?, name, providerType, baseUrl, apiKey?, models?, contextWindow?, maxTokens? }
 * - DELETE /provider/custom/:id -> { removed: true }
 * - PATCH /provider/:id/settings accepts contextWindow/maxTokens; a positive
 *   integer stores an override, null/0/empty resets to the catalog value.
 */

export interface ProviderOption {
  id: string;
  name?: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeProviderEntry = (entry: unknown): ProviderOption | null => {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  if (!isRecord(entry)) {
    return null;
  }
  const idCandidate =
    (typeof entry.id === 'string' && entry.id) ||
    (typeof entry.providerID === 'string' && entry.providerID) ||
    (typeof entry.slug === 'string' && entry.slug) ||
    (typeof entry.name === 'string' && entry.name);
  if (!idCandidate) {
    return null;
  }
  const nameCandidate = typeof entry.name === 'string' ? entry.name : undefined;
  return { id: idCandidate, name: nameCandidate };
};

/**
 * Parses the GET /provider payload. Accepts the frozen `{ all: [...] }` shape,
 * the legacy `{ providers: [...] }` shape, and a bare array.
 */
export const parseProvidersPayload = (payload: unknown): ProviderOption[] => {
  let entries: unknown[] = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.all)) {
      entries = payload.all;
    } else if (Array.isArray(payload.providers)) {
      entries = payload.providers;
    }
  }

  const mapped = entries
    .map((entry) => normalizeProviderEntry(entry))
    .filter((entry): entry is ProviderOption => Boolean(entry));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};

export type PositiveIntOverrideParse =
  | { kind: 'empty' }
  | { kind: 'valid'; value: number }
  | { kind: 'invalid' };

/**
 * Parses an optional numeric override input. Empty/whitespace means "inherit
 * the catalog default" (reset); otherwise the value must be a positive integer.
 */
export const parsePositiveIntOverride = (raw: string): PositiveIntOverrideParse => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'empty' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'invalid' };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', value };
};

/** Converts a settings payload number into input text ('' when unset/invalid). */
export const settingsNumberToInput = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return '';
};

export interface HaoCodeSettingsDraft {
  baseUrl: string;
  providerType: string;
  model: string;
  contextWindow: string;
  maxTokens: string;
}

/**
 * Builds the PATCH /provider/:id/settings body. Empty numeric overrides are
 * sent as null so the server resets them to the catalog defaults.
 */
export const buildHaoCodeSettingsPatch = (draft: HaoCodeSettingsDraft): Record<string, unknown> => {
  const contextWindow = parsePositiveIntOverride(draft.contextWindow);
  const maxTokens = parsePositiveIntOverride(draft.maxTokens);
  return {
    baseUrl: draft.baseUrl,
    providerType: draft.providerType,
    model: draft.model,
    contextWindow: contextWindow.kind === 'valid' ? contextWindow.value : null,
    maxTokens: maxTokens.kind === 'valid' ? maxTokens.value : null,
  };
};

/** Parses a comma-separated model ID list into trimmed, deduplicated IDs. */
export const parseModelIdList = (raw: string): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
};

export interface CustomProviderDraft {
  name: string;
  baseUrl: string;
  providerType: string;
  apiKey: string;
  models: string;
  contextWindow: string;
  maxTokens: string;
}

export type CustomProviderBuildError =
  | 'nameRequired'
  | 'baseUrlRequired'
  | 'invalidNumber';

export type CustomProviderBuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: CustomProviderBuildError };

export const DEFAULT_CUSTOM_PROVIDER_TYPE = 'openai_chat';

/**
 * Validates the custom-provider form and builds the PUT /provider/custom body.
 * Optional fields are omitted when empty so the server applies its defaults.
 */
export const buildCustomProviderBody = (draft: CustomProviderDraft): CustomProviderBuildResult => {
  const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  if (name.length === 0) {
    return { ok: false, error: 'nameRequired' };
  }
  if (baseUrl.length === 0) {
    return { ok: false, error: 'baseUrlRequired' };
  }

  const contextWindow = parsePositiveIntOverride(draft.contextWindow);
  const maxTokens = parsePositiveIntOverride(draft.maxTokens);
  if (contextWindow.kind === 'invalid' || maxTokens.kind === 'invalid') {
    return { ok: false, error: 'invalidNumber' };
  }

  const body: Record<string, unknown> = {
    name,
    providerType: draft.providerType.trim() || DEFAULT_CUSTOM_PROVIDER_TYPE,
    baseUrl,
  };

  const apiKey = draft.apiKey.trim();
  if (apiKey.length > 0) {
    body.apiKey = apiKey;
  }
  const models = parseModelIdList(draft.models);
  if (models.length > 0) {
    body.models = models;
  }
  if (contextWindow.kind === 'valid') {
    body.contextWindow = contextWindow.value;
  }
  if (maxTokens.kind === 'valid') {
    body.maxTokens = maxTokens.value;
  }

  return { ok: true, body };
};

export interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

/** Whether the provider was created through PUT /provider/custom. */
export const isCustomProvider = (sources?: ProviderSources): boolean =>
  Boolean(sources?.custom?.exists);

/** Extracts the id of a freshly created custom provider from the PUT response. */
export const extractCreatedProviderId = (payload: unknown): string | null => {
  const candidates: unknown[] = [payload];
  if (isRecord(payload)) {
    candidates.push(payload.provider, payload.data);
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (typeof candidate.id === 'string' && candidate.id.length > 0) {
      return candidate.id;
    }
  }
  return null;
};
