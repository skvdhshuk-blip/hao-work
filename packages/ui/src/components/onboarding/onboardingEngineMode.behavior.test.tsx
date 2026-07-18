import { afterEach, describe, expect, mock, test } from 'bun:test';

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);
type HookCallback = (...args: unknown[]) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
type JSXElementType<P extends Record<string, unknown> = Record<string, unknown>> = ComponentFn<P> | string | symbol;

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): unknown => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<T extends HookCallback>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useRef<T>(initialValue: T): { current: T } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  return record.values[index] as { current: T };
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function'
      ? (initialValue as () => T)()
      : initialValue;
  }

  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function'
      ? (next as (prev: T) => T)(record.values[index] as T)
      : next;
  };

  return [record.values[index] as T, setState] as const;
}

function jsx<P extends Record<string, unknown>>(type: JSXElementType<P>, props: JSXProps & P): unknown {
  if (type === reactJsxRuntime.Fragment) {
    return props.children ?? null;
  }

  if (typeof type === 'function') {
    return renderComponent(type, props as P);
  }

  return { type, props };
}

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

// Controllable /health responder. `healthPayload === null` simulates a failed fetch.
let healthPayload: unknown = null;
let desktopShell = false;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string) => {
    if (url === '/health') {
      if (healthPayload === null) {
        throw new Error('offline');
      }
      return { ok: true, json: async () => healthPayload };
    }
    return { ok: false, json: async () => ({}) };
  }),
}));

mock.module('@/lib/desktop', () => ({
  isDesktopShell: mock(() => desktopShell),
  requestFileAccess: mock(async () => ({ success: false })),
  startDesktopWindowDrag: mock(async () => {}),
  restartDesktopApp: mock(async () => {}),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => {}),
}));

mock.module('@/lib/clipboard', () => ({
  copyTextToClipboard: mock(async () => ({ ok: true })),
}));

mock.module('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));

// Faithful copies of the pure helpers from '@/lib/desktopHosts'. The module is
// mocked process-wide in bun test, and neighboring test files exercise these
// exact behaviors through desktopRecoveryConfig — so the mock must preserve
// them verbatim instead of stubbing them.
const SENSITIVE_QUERY_KEY = /^(t|.*(?:token|auth|secret|api).*)$/i;

const normalizeHostUrlImpl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return trimmed.split('#')[0] || null;
  } catch {
    return null;
  }
};

const redactSensitiveUrlImpl = (raw: string): string => {
  const normalized = normalizeHostUrlImpl(raw);
  if (!normalized) {
    return raw;
  }

  try {
    const url = new URL(normalized);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }

    const keys = Array.from(new Set(Array.from(url.searchParams.keys())));
    for (const key of keys) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: mock(async () => null),
  desktopHostsSet: mock(async () => {}),
  // Remaining exports kept available so other modules sharing this test
  // process (e.g. desktopRecoveryConfig via neighboring test files) still
  // resolve every named export of the real module.
  relayHostDisplayUrl: (serverId: string) => `relay://${serverId}`,
  normalizeHostUrl: normalizeHostUrlImpl,
  resolveDesktopHostUrl: () => null,
  redactSensitiveUrl: redactSensitiveUrlImpl,
  locationMatchesHost: () => false,
  getDesktopHostApiUrl: () => '',
  desktopLocalClientTokenGet: mock(async () => ''),
  desktopInstallIdGet: mock(async () => ''),
  probeRelayDesktopHost: mock(async () => ({ ok: false })),
  desktopHostProbe: mock(async () => ({ ok: false })),
  desktopOpenNewWindowAtUrl: mock(async () => {}),
  desktopOpenNewWindowForHost: mock(async () => {}),
}));

mock.module('@/components/ui/input', () => ({
  Input: () => null,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: unknown }) => children ?? null,
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('./RemoteConnectionForm', () => ({
  RemoteConnectionForm: () => null,
}));

const { ChooserScreen } = await import('./ChooserScreen');
const { LocalSetupScreen } = await import('./LocalSetupScreen');

const realSetTimeout = globalThis.setTimeout;
let scheduledTicks: Array<() => unknown> = [];

const installTimerStub = () => {
  scheduledTicks = [];
  globalThis.setTimeout = ((fn: (...args: unknown[]) => unknown, ms?: number) => {
    if ((ms ?? 0) >= 1000) {
      // Long-delay callbacks are the onboarding poll/hint timers: capture them
      // so tests can fire ticks manually instead of waiting real seconds.
      scheduledTicks.push(fn as () => unknown);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
};

const restoreTimers = () => {
  globalThis.setTimeout = realSetTimeout;
  scheduledTicks = [];
};

const runScheduledTicks = async () => {
  const ticks = scheduledTicks;
  scheduledTicks = [];
  for (const tick of ticks) {
    await tick();
  }
};

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  await Promise.resolve();
};

const collectText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(' ');
  if (typeof node === 'object') {
    const element = node as { props?: { children?: unknown } };
    return collectText(element.props?.children);
  }
  return '';
};

afterEach(() => {
  restoreTimers();
  resetHarness();
  desktopShell = false;
  healthPayload = null;
});

describe('ChooserScreen bundled engine mode', () => {
  test('shows engine-startup waiting copy and hides install guidance once /health reports haocode', async () => {
    installTimerStub();
    desktopShell = true;
    healthPayload = { agentEngine: 'haocode', isOpenCodeReady: false };

    renderComponent(ChooserScreen, {});
    await flushEffects();
    await runScheduledTicks();
    const tree = renderComponent(ChooserScreen, {});
    await flushEffects();
    const text = collectText(tree);

    expect(text).toContain('onboarding.localSetup.bundledEngine.description');
    expect(text).toContain('onboarding.localSetup.bundledEngine.status.waiting');
    expect(text).toContain('onboarding.localSetup.bundledEngine.status.autoContinue');
    expect(text).not.toContain('onboarding.localSetup.intro');
    expect(text).not.toContain('onboarding.localSetup.status.watching');
    expect(text).not.toContain('onboarding.localSetup.advanced.title');
    expect(text).not.toContain('onboarding.localSetup.troubleshoot.title');
    expect(text).not.toContain('curl');
    // Remote connection entry stays available.
    expect(text).toContain('onboarding.chooser.tabs.connectRemote');
  });

  test('keeps install guidance when the engine marker is not haocode', async () => {
    installTimerStub();
    healthPayload = { agentEngine: 'opencode', isOpenCodeReady: false };

    renderComponent(ChooserScreen, {});
    await flushEffects();
    await runScheduledTicks();
    const tree = renderComponent(ChooserScreen, {});
    await flushEffects();
    const text = collectText(tree);

    expect(text).toContain('onboarding.localSetup.intro');
    expect(text).toContain('onboarding.localSetup.advanced.title');
    expect(text).toContain('onboarding.localSetup.status.watching');
    expect(text).not.toContain('onboarding.localSetup.bundledEngine.description');
  });

  test('keeps install guidance when the health snapshot has no engine marker', async () => {
    installTimerStub();
    healthPayload = { isOpenCodeReady: false };

    renderComponent(ChooserScreen, {});
    await flushEffects();
    await runScheduledTicks();
    const tree = renderComponent(ChooserScreen, {});
    await flushEffects();
    const text = collectText(tree);

    expect(text).toContain('onboarding.localSetup.intro');
    expect(text).not.toContain('onboarding.localSetup.bundledEngine.description');
  });

  test('does not show install guidance before the first health response arrives', async () => {
    installTimerStub();
    healthPayload = null; // fetch failing: engine mode stays unknown

    const tree = renderComponent(ChooserScreen, {});
    await flushEffects();
    const text = collectText(tree);

    expect(text).not.toContain('onboarding.localSetup.intro');
    expect(text).not.toContain('onboarding.localSetup.advanced.title');
    expect(text).toContain('onboarding.localSetup.bundledEngine.status.waiting');
  });

  test('polling still auto-continues as soon as the bundled engine is ready', async () => {
    installTimerStub();
    healthPayload = { agentEngine: 'haocode', isOpenCodeReady: true };
    let availableCalls = 0;
    const onCliAvailable = () => {
      availableCalls += 1;
    };

    renderComponent(ChooserScreen, { onCliAvailable });
    await flushEffects();
    await runScheduledTicks();
    await flushEffects();

    expect(availableCalls).toBe(1);
  });
});

describe('LocalSetupScreen bundled engine mode', () => {
  test('swaps title/description to engine-startup copy and hides install UI once /health reports haocode', async () => {
    installTimerStub();
    healthPayload = { agentEngine: 'haocode', isOpenCodeReady: false };
    const onBack = mock(() => {});
    const onSwitchToRemote = mock(() => {});

    const props = { onBack, isFromRecovery: true, onSwitchToRemote };
    renderComponent(LocalSetupScreen, props);
    await flushEffects();
    await runScheduledTicks();
    const tree = renderComponent(LocalSetupScreen, props);
    await flushEffects();
    const text = collectText(tree);

    expect(text).toContain('onboarding.localSetup.bundledEngine.title');
    expect(text).toContain('onboarding.localSetup.bundledEngine.description');
    expect(text).toContain('onboarding.localSetup.bundledEngine.status.waiting');
    expect(text).not.toContain('onboarding.localSetup.description');
    expect(text).not.toContain('onboarding.localSetup.field.alreadyInstalled');
    expect(text).not.toContain('onboarding.localSetup.actions.checkAndContinue');
    expect(text).not.toContain('onboarding.localSetup.helper.saveAndReload');
    expect(text).not.toContain('onboarding.localSetup.docs.default');
    // Back navigation and the remote-server escape hatch remain visible.
    expect(text).toContain('onboarding.common.actions.back');
    expect(text).toContain('onboarding.localSetup.remotePreference');
    expect(text).toContain('onboarding.localSetup.actions.connectRemoteServer');
  });

  test('keeps install guidance when the engine marker is not haocode', async () => {
    installTimerStub();
    healthPayload = { agentEngine: 'opencode', isOpenCodeReady: false };
    const onBack = mock(() => {});

    const props = { onBack };
    renderComponent(LocalSetupScreen, props);
    await flushEffects();
    await runScheduledTicks();
    const tree = renderComponent(LocalSetupScreen, props);
    await flushEffects();
    const text = collectText(tree);

    expect(text).toContain('onboarding.localSetup.description');
    expect(text).toContain('onboarding.localSetup.field.alreadyInstalled');
    expect(text).not.toContain('onboarding.localSetup.bundledEngine.title');
  });

  test('polling auto-continues as soon as the bundled engine is ready', async () => {
    installTimerStub();
    healthPayload = { agentEngine: 'haocode', isOpenCodeReady: true };
    const onBack = mock(() => {});
    let availableCalls = 0;
    const onCliAvailable = () => {
      availableCalls += 1;
    };

    renderComponent(LocalSetupScreen, { onBack, onCliAvailable });
    await flushEffects();
    await runScheduledTicks();
    await flushEffects();

    expect(availableCalls).toBe(1);
  });
});
