import { describe, expect, test } from 'bun:test';

import {
  buildCustomProviderBody,
  buildHaoCodeSettingsPatch,
  DEFAULT_CUSTOM_PROVIDER_TYPE,
  DEFAULT_IMAGE_POLICY,
  extractCreatedProviderId,
  IMAGE_POLICIES,
  isCustomProvider,
  isImageVlmModelMissing,
  normalizeImagePolicy,
  parseModelIdList,
  parsePositiveIntOverride,
  parseProvidersPayload,
  settingsNumberToInput,
  settingsVlmModelToInput,
} from './providerSettings';

describe('parseProvidersPayload', () => {
  test('parses the frozen GET /provider { all } shape', () => {
    const payload = {
      all: [
        { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {} },
        { id: 'anthropic', name: 'Anthropic' },
      ],
      connected: ['openai'],
      default: { openai: 'gpt-5' },
    };
    expect(parseProvidersPayload(payload)).toEqual([
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
    ]);
  });

  test('accepts legacy { providers } shape and bare arrays', () => {
    expect(parseProvidersPayload({ providers: [{ id: 'a' }] })).toEqual([{ id: 'a', name: undefined }]);
    expect(parseProvidersPayload(['x', { id: 'y', name: 'Y' }])).toEqual([
      { id: 'x', name: undefined },
      { id: 'y', name: 'Y' },
    ]);
  });

  test('deduplicates entries and drops malformed ones', () => {
    const payload = {
      all: [
        { id: 'openai', name: 'OpenAI' },
        { id: 'openai', name: 'Duplicate' },
        { name: 'no-id-entry' },
        42,
        null,
      ],
    };
    // Entries with only a name fall back to name-as-id (existing behavior).
    expect(parseProvidersPayload(payload)).toEqual([
      { id: 'openai', name: 'OpenAI' },
      { id: 'no-id-entry', name: 'no-id-entry' },
    ]);
  });

  test('returns an empty list for unexpected payloads', () => {
    expect(parseProvidersPayload(null)).toEqual([]);
    expect(parseProvidersPayload({})).toEqual([]);
    expect(parseProvidersPayload('nope')).toEqual([]);
  });
});

describe('parsePositiveIntOverride', () => {
  test('treats empty and whitespace as inherit/reset', () => {
    expect(parsePositiveIntOverride('')).toEqual({ kind: 'empty' });
    expect(parsePositiveIntOverride('   ')).toEqual({ kind: 'empty' });
  });

  test('accepts positive integers', () => {
    expect(parsePositiveIntOverride('128000')).toEqual({ kind: 'valid', value: 128000 });
    expect(parsePositiveIntOverride(' 4096 ')).toEqual({ kind: 'valid', value: 4096 });
  });

  test('rejects zero, negatives, decimals, and non-numeric input', () => {
    expect(parsePositiveIntOverride('0')).toEqual({ kind: 'invalid' });
    expect(parsePositiveIntOverride('-5')).toEqual({ kind: 'invalid' });
    expect(parsePositiveIntOverride('1.5')).toEqual({ kind: 'invalid' });
    expect(parsePositiveIntOverride('abc')).toEqual({ kind: 'invalid' });
    expect(parsePositiveIntOverride('12k')).toEqual({ kind: 'invalid' });
  });
});

describe('settingsNumberToInput', () => {
  test('renders positive integers and hides unset/reset values', () => {
    expect(settingsNumberToInput(200000)).toBe('200000');
    expect(settingsNumberToInput(null)).toBe('');
    expect(settingsNumberToInput(0)).toBe('');
    expect(settingsNumberToInput(-1)).toBe('');
    expect(settingsNumberToInput('128000')).toBe('');
    expect(settingsNumberToInput(undefined)).toBe('');
  });
});

describe('buildHaoCodeSettingsPatch', () => {
  test('sends null for empty overrides so the server resets to catalog defaults', () => {
    expect(buildHaoCodeSettingsPatch({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: '',
      contextWindow: '',
      maxTokens: ' ',
      imagePolicy: 'native',
      imageVlmModel: '',
    })).toEqual({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: '',
      contextWindow: null,
      maxTokens: null,
      imagePolicy: 'native',
      imageVlmModel: null,
    });
  });

  test('sends numbers for valid overrides', () => {
    expect(buildHaoCodeSettingsPatch({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: 'my-model',
      contextWindow: '200000',
      maxTokens: '8192',
      imagePolicy: 'native',
      imageVlmModel: '',
    })).toEqual({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: 'my-model',
      contextWindow: 200000,
      maxTokens: 8192,
      imagePolicy: 'native',
      imageVlmModel: null,
    });
  });

  test('sends the selected image policy and a trimmed VLM model id', () => {
    expect(buildHaoCodeSettingsPatch({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: '',
      contextWindow: '',
      maxTokens: '',
      imagePolicy: 'vlm',
      imageVlmModel: '  qwen-vl-max  ',
    })).toEqual({
      baseUrl: 'https://api.example.com',
      providerType: 'openai_chat',
      model: '',
      contextWindow: null,
      maxTokens: null,
      imagePolicy: 'vlm',
      imageVlmModel: 'qwen-vl-max',
    });
  });
});

describe('IMAGE_POLICIES', () => {
  test('exposes the five frozen strategies in order', () => {
    expect(IMAGE_POLICIES).toEqual(['native', 'ocr', 'caption', 'vlm', 'drop']);
  });
});

describe('normalizeImagePolicy', () => {
  test('passes through valid policies', () => {
    for (const policy of IMAGE_POLICIES) {
      expect(normalizeImagePolicy(policy)).toBe(policy);
    }
  });

  test('falls back to the default for unknown or missing values', () => {
    expect(normalizeImagePolicy('bogus')).toBe(DEFAULT_IMAGE_POLICY);
    expect(normalizeImagePolicy(null)).toBe(DEFAULT_IMAGE_POLICY);
    expect(normalizeImagePolicy(undefined)).toBe(DEFAULT_IMAGE_POLICY);
    expect(normalizeImagePolicy(42)).toBe(DEFAULT_IMAGE_POLICY);
    expect(DEFAULT_IMAGE_POLICY).toBe('native');
  });
});

describe('settingsVlmModelToInput', () => {
  test('renders stored model ids and hides unset values', () => {
    expect(settingsVlmModelToInput('qwen-vl-max')).toBe('qwen-vl-max');
    expect(settingsVlmModelToInput(null)).toBe('');
    expect(settingsVlmModelToInput(undefined)).toBe('');
    expect(settingsVlmModelToInput(7)).toBe('');
  });
});

describe('isImageVlmModelMissing', () => {
  test('blocks saving the vlm policy without a model id', () => {
    expect(isImageVlmModelMissing('vlm', '')).toBe(true);
    expect(isImageVlmModelMissing('vlm', '   ')).toBe(true);
    expect(isImageVlmModelMissing('vlm', 'qwen-vl-max')).toBe(false);
  });

  test('does not require a model id for other policies', () => {
    for (const policy of ['native', 'ocr', 'caption', 'drop'] as const) {
      expect(isImageVlmModelMissing(policy, '')).toBe(false);
    }
  });
});

describe('parseModelIdList', () => {
  test('splits on commas, trims, dedupes, and drops empties', () => {
    expect(parseModelIdList('model-a, model-b,,model-a, , model-c')).toEqual(['model-a', 'model-b', 'model-c']);
    expect(parseModelIdList('')).toEqual([]);
  });
});

describe('buildCustomProviderBody', () => {
  const baseDraft = {
    name: 'My provider',
    baseUrl: 'https://api.example.com',
    providerType: '',
    apiKey: '',
    models: '',
    contextWindow: '',
    maxTokens: '',
  };

  test('requires a name and a base URL', () => {
    expect(buildCustomProviderBody({ ...baseDraft, name: ' ' })).toEqual({ ok: false, error: 'nameRequired' });
    expect(buildCustomProviderBody({ ...baseDraft, baseUrl: '' })).toEqual({ ok: false, error: 'baseUrlRequired' });
  });

  test('rejects invalid numeric overrides', () => {
    expect(buildCustomProviderBody({ ...baseDraft, contextWindow: '0' })).toEqual({ ok: false, error: 'invalidNumber' });
    expect(buildCustomProviderBody({ ...baseDraft, maxTokens: 'abc' })).toEqual({ ok: false, error: 'invalidNumber' });
  });

  test('defaults provider type and omits empty optional fields', () => {
    const result = buildCustomProviderBody(baseDraft);
    expect(result).toEqual({
      ok: true,
      body: {
        name: 'My provider',
        providerType: DEFAULT_CUSTOM_PROVIDER_TYPE,
        baseUrl: 'https://api.example.com',
      },
    });
  });

  test('includes optional fields when provided', () => {
    const result = buildCustomProviderBody({
      ...baseDraft,
      providerType: 'anthropic',
      apiKey: 'sk-test',
      models: 'm1, m2',
      contextWindow: '128000',
      maxTokens: '4096',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        name: 'My provider',
        providerType: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        models: ['m1', 'm2'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    });
  });
});

describe('isCustomProvider', () => {
  test('detects the custom source flag', () => {
    const sources = {
      auth: { exists: false },
      user: { exists: false },
      project: { exists: false },
      custom: { exists: true },
    };
    expect(isCustomProvider(sources)).toBe(true);
    expect(isCustomProvider({ ...sources, custom: { exists: false } })).toBe(false);
    expect(isCustomProvider({ auth: { exists: true }, user: { exists: false }, project: { exists: false } })).toBe(false);
    expect(isCustomProvider(undefined)).toBe(false);
  });
});

describe('extractCreatedProviderId', () => {
  test('reads ids from flat or wrapped responses', () => {
    expect(extractCreatedProviderId({ id: 'custom-1' })).toBe('custom-1');
    expect(extractCreatedProviderId({ provider: { id: 'custom-2' } })).toBe('custom-2');
    expect(extractCreatedProviderId({ data: { id: 'custom-3' } })).toBe('custom-3');
    expect(extractCreatedProviderId(null)).toBeNull();
    expect(extractCreatedProviderId({ name: 'no-id' })).toBeNull();
  });
});
