import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  isServerThemeMigrationDone,
  markServerThemeMigrationDone,
  migrateDesktopSettingsThemeIds,
  migrateLegacyDefaultThemeIds,
  THEME_MIGRATION_NEON_GRID_V1_KEY,
} from './theme-default-migration';

const originalWindow = globalThis.window;
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

let backingStorage: Map<string, string>;

const installStorage = () => {
  backingStorage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: undefined },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => backingStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backingStorage.set(key, value);
      },
      removeItem: (key: string) => {
        backingStorage.delete(key);
      },
      clear: () => {
        backingStorage.clear();
      },
    },
  });
};

const seedStorage = (entries: Record<string, string>) => {
  for (const [key, value] of Object.entries(entries)) {
    localStorage.setItem(key, value);
  }
};

const snapshotFromStorage = () => ({
  lightThemeId: localStorage.getItem('lightThemeId'),
  darkThemeId: localStorage.getItem('darkThemeId'),
  selectedThemeId: localStorage.getItem('selectedThemeId'),
});

beforeEach(() => {
  installStorage();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  }
});

describe('migrateLegacyDefaultThemeIds', () => {
  test('migrates stored old defaults to neon-grid and writes them back', () => {
    seedStorage({
      lightThemeId: 'flexoki-light',
      darkThemeId: 'flexoki-dark',
      selectedThemeId: 'flexoki-light',
    });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result).toEqual({
      lightThemeId: 'neon-grid-light',
      darkThemeId: 'neon-grid-dark',
      selectedThemeId: 'neon-grid-light',
    });
    expect(localStorage.getItem('lightThemeId')).toBe('neon-grid-light');
    expect(localStorage.getItem('darkThemeId')).toBe('neon-grid-dark');
    expect(localStorage.getItem('selectedThemeId')).toBe('neon-grid-light');
    expect(localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_KEY)).toBe('done');
  });

  test('migrates the legacy selectedThemeId flexoki-dark variant', () => {
    seedStorage({ selectedThemeId: 'flexoki-dark' });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result.selectedThemeId).toBe('neon-grid-dark');
    expect(localStorage.getItem('selectedThemeId')).toBe('neon-grid-dark');
    // Untouched slots must not gain new keys.
    expect(localStorage.getItem('lightThemeId')).toBeNull();
    expect(localStorage.getItem('darkThemeId')).toBeNull();
  });

  test('leaves explicitly chosen themes untouched but still sets the flag', () => {
    seedStorage({
      lightThemeId: 'fields-of-the-shire-light',
      darkThemeId: 'kanagawa-dark',
      selectedThemeId: 'flexoki-light',
    });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result.lightThemeId).toBe('fields-of-the-shire-light');
    expect(result.darkThemeId).toBe('kanagawa-dark');
    // The legacy selectedThemeId slot still migrates on its own old-default match.
    expect(result.selectedThemeId).toBe('neon-grid-light');
    expect(localStorage.getItem('lightThemeId')).toBe('fields-of-the-shire-light');
    expect(localStorage.getItem('darkThemeId')).toBe('kanagawa-dark');
    expect(localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_KEY)).toBe('done');
  });

  test('fresh install only records the flag', () => {
    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result).toEqual({
      lightThemeId: null,
      darkThemeId: null,
      selectedThemeId: null,
    });
    expect(localStorage.getItem('lightThemeId')).toBeNull();
    expect(localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_KEY)).toBe('done');
  });

  test('never migrates again once the flag is set', () => {
    seedStorage({ lightThemeId: 'flexoki-light' });
    migrateLegacyDefaultThemeIds(snapshotFromStorage());
    expect(localStorage.getItem('lightThemeId')).toBe('neon-grid-light');

    // User deliberately switches back to flexoki after the migration.
    seedStorage({ lightThemeId: 'flexoki-light', darkThemeId: 'flexoki-dark' });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result.lightThemeId).toBe('flexoki-light');
    expect(result.darkThemeId).toBe('flexoki-dark');
    expect(localStorage.getItem('lightThemeId')).toBe('flexoki-light');
    expect(localStorage.getItem('darkThemeId')).toBe('flexoki-dark');
  });

  test('embedded contexts get in-memory migration without storage writes', () => {
    seedStorage({
      lightThemeId: 'flexoki-light',
      darkThemeId: 'flexoki-dark',
    });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage(), { allowPersist: false });

    expect(result.lightThemeId).toBe('neon-grid-light');
    expect(result.darkThemeId).toBe('neon-grid-dark');
    expect(localStorage.getItem('lightThemeId')).toBe('flexoki-light');
    expect(localStorage.getItem('darkThemeId')).toBe('flexoki-dark');
    expect(localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_KEY)).toBeNull();
  });

  test('handles whitespace-padded stored ids', () => {
    seedStorage({ lightThemeId: '  flexoki-light  ' });

    const result = migrateLegacyDefaultThemeIds(snapshotFromStorage());

    expect(result.lightThemeId).toBe('neon-grid-light');
    expect(localStorage.getItem('lightThemeId')).toBe('neon-grid-light');
  });
});

describe('migrateDesktopSettingsThemeIds (server settings copy)', () => {
  test('maps old-default ids in the server copy and reports the changes', () => {
    const { settings, changes } = migrateDesktopSettingsThemeIds({
      themeId: 'flexoki-light',
      lightThemeId: 'flexoki-light',
      darkThemeId: 'flexoki-dark',
      lastDirectory: '/tmp/project',
    });

    expect(settings).toEqual({
      themeId: 'neon-grid-light',
      lightThemeId: 'neon-grid-light',
      darkThemeId: 'neon-grid-dark',
      lastDirectory: '/tmp/project',
    });
    expect(changes).toEqual({
      themeId: 'neon-grid-light',
      lightThemeId: 'neon-grid-light',
      darkThemeId: 'neon-grid-dark',
    });
  });

  test('leaves explicit choices and absent fields untouched', () => {
    const { settings, changes } = migrateDesktopSettingsThemeIds({
      lightThemeId: 'fields-of-the-shire-light',
    });

    expect(settings.lightThemeId).toBe('fields-of-the-shire-light');
    expect('darkThemeId' in settings).toBe(false);
    expect(changes).toEqual({});
  });

  test('server migration flag round-trips through localStorage', () => {
    expect(isServerThemeMigrationDone()).toBe(false);
    markServerThemeMigrationDone();
    expect(isServerThemeMigrationDone()).toBe(true);
  });
});
