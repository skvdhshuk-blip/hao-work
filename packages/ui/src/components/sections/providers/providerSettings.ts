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
 * - PATCH /provider/:id/settings also accepts imagePolicy
 *   ('native'|'ocr'|'caption'|'vlm'|'drop', default 'native') and
 *   imageVlmModel (string|null, required when imagePolicy is 'vlm').
 * - Individual models override the provider imagePolicy through
 *   modelImagePolicies ({ [modelID]: policy }, reported by the settings GET).
 *   PATCH with modelImagePolicy: { model, policy } sets one model's override;
 *   policy: null clears it so the model falls back to the provider default.
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

/** Image handling strategies accepted by PATCH /provider/:id/settings. */
export const IMAGE_POLICIES = ['native', 'ocr', 'caption', 'vlm', 'drop'] as const;

export type ImagePolicy = (typeof IMAGE_POLICIES)[number];

export const DEFAULT_IMAGE_POLICY: ImagePolicy = 'native';

/** Normalizes a settings payload image policy; unknown values fall back to the default. */
export const normalizeImagePolicy = (value: unknown): ImagePolicy =>
  (IMAGE_POLICIES as readonly unknown[]).includes(value) ? (value as ImagePolicy) : DEFAULT_IMAGE_POLICY;

/** Converts a settings payload VLM model id into input text ('' when unset). */
export const settingsVlmModelToInput = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Per-model image policy overrides keyed by model id. */
export type ModelImagePolicies = Record<string, ImagePolicy>;

/** Sanitizes a settings payload per-model policy map; unknown entries are dropped. */
export const normalizeModelImagePolicies = (value: unknown): ModelImagePolicies => {
  if (!isRecord(value) || Array.isArray(value)) {
    return {};
  }
  const result: ModelImagePolicies = {};
  for (const [model, policy] of Object.entries(value)) {
    if (model.length > 0 && (IMAGE_POLICIES as readonly unknown[]).includes(policy)) {
      result[model] = policy as ImagePolicy;
    }
  }
  return result;
};

/** Effective policy for one model: per-model override, else the provider default. */
export const resolveModelImagePolicy = (
  overrides: ModelImagePolicies,
  providerDefault: ImagePolicy,
  modelId: string,
): ImagePolicy => overrides[modelId] ?? providerDefault;

/**
 * Builds the PATCH /provider/:id/settings body that sets one model's image
 * policy override, or clears it when policy is null (back to the provider default).
 */
export const buildModelImagePolicyPatch = (model: string, policy: ImagePolicy | null): Record<string, unknown> => ({
  modelImagePolicy: { model, policy },
});

/** The 'vlm' policy cannot be saved without a model id; other policies can. */
export const isImageVlmModelMissing = (policy: ImagePolicy, model: string): boolean =>
  policy === 'vlm' && model.trim().length === 0;

export interface HaoCodeSettingsDraft {
  baseUrl: string;
  providerType: string;
  model: string;
  contextWindow: string;
  maxTokens: string;
  imagePolicy: ImagePolicy;
  imageVlmModel: string;
}

/**
 * Builds the PATCH /provider/:id/settings body. Empty numeric overrides are
 * sent as null so the server resets them to the catalog defaults. An empty
 * VLM model id is sent as null so the server clears it.
 */
export const buildHaoCodeSettingsPatch = (draft: HaoCodeSettingsDraft): Record<string, unknown> => {
  const contextWindow = parsePositiveIntOverride(draft.contextWindow);
  const maxTokens = parsePositiveIntOverride(draft.maxTokens);
  const imageVlmModel = draft.imageVlmModel.trim();
  return {
    baseUrl: draft.baseUrl,
    providerType: draft.providerType,
    model: draft.model,
    contextWindow: contextWindow.kind === 'valid' ? contextWindow.value : null,
    maxTokens: maxTokens.kind === 'valid' ? maxTokens.value : null,
    imagePolicy: normalizeImagePolicy(draft.imagePolicy),
    imageVlmModel: imageVlmModel.length > 0 ? imageVlmModel : null,
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
