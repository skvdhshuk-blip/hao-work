/**
 * Onboarding engine detection helpers.
 *
 * The local server bundles the hao-code engine and advertises it via the
 * `/health` snapshot field `agentEngine: 'haocode'`. Onboarding screens use
 * this to decide between two copy modes:
 *
 * - `bundled`: the engine ships with the app — show a startup waiting screen,
 *   never CLI install instructions.
 * - `external`: the health snapshot names a different engine — keep the
 *   classic "install the CLI" guidance.
 * - `unknown`: no health response has been parsed yet (or every fetch has
 *   failed). Until the first snapshot arrives we must NOT show install
 *   guidance, so this mode renders like `bundled`.
 */
export type OnboardingEngineMode = 'unknown' | 'bundled' | 'external';

export type OnboardingHealthSnapshot = {
  agentEngine?: unknown;
  openCodeRunning?: unknown;
  isOpenCodeReady?: unknown;
};

const BUNDLED_AGENT_ENGINE = 'haocode';

export function resolveEngineMode(health: unknown): OnboardingEngineMode {
  if (!health || typeof health !== 'object') return 'unknown';
  const engine = (health as OnboardingHealthSnapshot).agentEngine;
  if (typeof engine !== 'string' || engine.length === 0) return 'external';
  return engine === BUNDLED_AGENT_ENGINE ? 'bundled' : 'external';
}

export function isEngineReady(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  const data = health as OnboardingHealthSnapshot;
  return data.openCodeRunning === true || data.isOpenCodeReady === true;
}
