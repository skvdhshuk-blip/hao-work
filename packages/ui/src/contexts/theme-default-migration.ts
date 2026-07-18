import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from '@/lib/theme/themes';

export const THEME_MIGRATION_NEON_GRID_V1_KEY = 'themeMigration.neonGridV1';

// Theme ids that shipped as the built-in defaults before neon-grid became the
// default. A stored value exactly matching one of these is treated as "never
// explicitly chosen" and migrated once; any other stored id is a deliberate
// user choice and is left untouched.
const LEGACY_DEFAULT_THEME_ID_MAP: Record<string, string> = {
  'flexoki-light': DEFAULT_LIGHT_THEME_ID,
  'flexoki-dark': DEFAULT_DARK_THEME_ID,
};

type LegacyDefaultThemeSnapshot = {
  lightThemeId: string | null;
  darkThemeId: string | null;
  selectedThemeId: string | null;
};

const migrateThemeId = (value: string | null): string | null => {
  if (typeof value !== 'string') {
    return value;
  }
  return LEGACY_DEFAULT_THEME_ID_MAP[value.trim()] ?? value;
};

/**
 * One-time migration for the neon-grid default theme rollout.
 *
 * Startup reads `lightThemeId`/`darkThemeId` from localStorage with priority
 * over the built-in defaults, so users who never picked a theme keep booting
 * into the old flexoki defaults forever. This rewrites exact old-default
 * matches to the neon-grid defaults, writes them back, and sets a flag key so
 * the migration never runs again — a user who picks flexoki deliberately
 * afterwards is therefore never migrated.
 *
 * `allowPersist: false` is used by embedded contexts, where theme search
 * params (and parent theme sync) own the effective theme and localStorage
 * writes are suppressed: the migrated ids are returned for in-memory use
 * without touching storage or the flag, so URL-explicit themes always win.
 */
export const migrateLegacyDefaultThemeIds = (
  snapshot: LegacyDefaultThemeSnapshot,
  options: { allowPersist?: boolean } = {},
): LegacyDefaultThemeSnapshot => {
  if (typeof window === 'undefined') {
    return snapshot;
  }

  let alreadyDone = false;
  try {
    alreadyDone = localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_KEY) === 'done';
  } catch {
    // Storage unavailable (e.g. blocked): keep booting with stored values.
    return snapshot;
  }

  if (alreadyDone) {
    return snapshot;
  }

  const next: LegacyDefaultThemeSnapshot = {
    lightThemeId: migrateThemeId(snapshot.lightThemeId),
    darkThemeId: migrateThemeId(snapshot.darkThemeId),
    selectedThemeId: migrateThemeId(snapshot.selectedThemeId),
  };

  if (options.allowPersist === false) {
    return next;
  }

  try {
    if (next.lightThemeId !== snapshot.lightThemeId && typeof next.lightThemeId === 'string') {
      localStorage.setItem('lightThemeId', next.lightThemeId);
    }
    if (next.darkThemeId !== snapshot.darkThemeId && typeof next.darkThemeId === 'string') {
      localStorage.setItem('darkThemeId', next.darkThemeId);
    }
    if (next.selectedThemeId !== snapshot.selectedThemeId && typeof next.selectedThemeId === 'string') {
      localStorage.setItem('selectedThemeId', next.selectedThemeId);
    }
    localStorage.setItem(THEME_MIGRATION_NEON_GRID_V1_KEY, 'done');
  } catch {
    // Partial write failure is safe: untouched keys keep their previous
    // values and the unset flag retries the migration on next launch.
  }

  return next;
};

export const THEME_MIGRATION_NEON_GRID_V1_SERVER_KEY = 'themeMigration.neonGridV1.server';

export type DesktopThemeIdSettings = {
  themeId?: string;
  lightThemeId?: string;
  darkThemeId?: string;
};

const migrateOptionalThemeId = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') {
    return value;
  }
  return LEGACY_DEFAULT_THEME_ID_MAP[value.trim()] ?? value;
};

/**
 * Server-copy companion of the boot-time localStorage migration.
 *
 * `syncDesktopSettings` applies the server-persisted DesktopSettings after
 * startup and writes their theme ids back into localStorage, which silently
 * undoes the boot migration when the server copy still holds the old flexoki
 * defaults. This pure mapping heals the server copy itself; the caller
 * persists the returned `changes` and flips the server flag exactly once, so
 * a deliberate flexoki re-selection afterwards is never re-migrated.
 */
export const migrateDesktopSettingsThemeIds = <T extends DesktopThemeIdSettings>(
  settings: T,
): { settings: T; changes: DesktopThemeIdSettings } => {
  const changes: DesktopThemeIdSettings = {};
  const next: T = { ...settings };
  const writable = next as Record<string, string | undefined>;
  const keys = ['themeId', 'lightThemeId', 'darkThemeId'] as const;
  for (const key of keys) {
    const migrated = migrateOptionalThemeId(settings[key]);
    if (migrated !== settings[key]) {
      writable[key] = migrated;
      changes[key] = migrated;
    }
  }
  return { settings: next, changes };
};

export const isServerThemeMigrationDone = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    return localStorage.getItem(THEME_MIGRATION_NEON_GRID_V1_SERVER_KEY) === 'done';
  } catch {
    return true;
  }
};

export const markServerThemeMigrationDone = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(THEME_MIGRATION_NEON_GRID_V1_SERVER_KEY, 'done');
  } catch {
    // Storage unavailable: migration retries on next launch; mapping is
    // idempotent so a repeated heal is harmless.
  }
};
