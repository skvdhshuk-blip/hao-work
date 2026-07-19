// Sandbox config helpers mirror hitlApproval.ts: typed sanitize/read/build
// functions over the adapter-owned `_fe_sandbox*` keys in state.config. The
// server (compat-server.js buildSandboxRequest) reads the same keys, so any
// normalization rule here must hold on both sides. Keep defaults aligned with
// DEFAULT_SANDBOX_MEMORY_MB / DEFAULT_SANDBOX_CPU_COUNT in compat-server.js.

export type SandboxNetwork = 'blocked' | 'allow-all';

export const SANDBOX_NETWORKS: readonly SandboxNetwork[] = ['blocked', 'allow-all'];

export const DEFAULT_SANDBOX_MEMORY_MB = 4096;
export const DEFAULT_SANDBOX_CPU_COUNT = 4;
export const MIN_SANDBOX_MEMORY_MB = 256;
export const MAX_SANDBOX_MEMORY_MB = 16384;
export const MIN_SANDBOX_CPU_COUNT = 1;
export const MAX_SANDBOX_CPU_COUNT = 8;

type SandboxConfig = {
  enabled: boolean;
  baseRootfs: string;
  network: SandboxNetwork;
  memoryMb: number;
  cpuCount: number;
};

export const sanitizeSandboxNetwork = (value: unknown): SandboxNetwork => {
  return value === 'allow-all' ? 'allow-all' : 'blocked';
};

const sanitizeMemoryMb = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SANDBOX_MEMORY_MB;
  return Math.min(MAX_SANDBOX_MEMORY_MB, Math.max(MIN_SANDBOX_MEMORY_MB, Math.round(n)));
};

const sanitizeCpuCount = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SANDBOX_CPU_COUNT;
  return Math.min(MAX_SANDBOX_CPU_COUNT, Math.max(MIN_SANDBOX_CPU_COUNT, Math.round(n)));
};

export const readSandboxConfig = (config: unknown): SandboxConfig => {
  const record = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  return {
    enabled: record._fe_sandboxEnabled === true,
    baseRootfs: typeof record._fe_sandboxBaseRootfs === 'string' ? record._fe_sandboxBaseRootfs : '',
    network: sanitizeSandboxNetwork(record._fe_sandboxNetwork),
    memoryMb: sanitizeMemoryMb(record._fe_sandboxMemoryMb),
    cpuCount: sanitizeCpuCount(record._fe_sandboxCpuCount),
  };
};

// Build a patch object for opencodeClient.updateConfig. null values clear the
// key (server treats absent and null equivalently). The enabled toggle sets
// the boolean directly.
export const buildSandboxPatch = (partial: Partial<SandboxConfig>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (partial.enabled !== undefined) patch._fe_sandboxEnabled = partial.enabled === true;
  if (partial.network !== undefined) patch._fe_sandboxNetwork = sanitizeSandboxNetwork(partial.network);
  if (partial.memoryMb !== undefined) patch._fe_sandboxMemoryMb = sanitizeMemoryMb(partial.memoryMb);
  if (partial.cpuCount !== undefined) patch._fe_sandboxCpuCount = sanitizeCpuCount(partial.cpuCount);
  // baseRootfs is managed by the server (/sandbox/prepare writes it); UI does
  // not set it directly, so it is intentionally absent from this builder.
  return patch;
};
