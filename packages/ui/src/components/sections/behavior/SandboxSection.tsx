import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import { Radio } from '@/components/ui/radio';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import {
  DEFAULT_SANDBOX_CPU_COUNT,
  DEFAULT_SANDBOX_MEMORY_MB,
  MAX_SANDBOX_CPU_COUNT,
  MAX_SANDBOX_MEMORY_MB,
  MIN_SANDBOX_CPU_COUNT,
  MIN_SANDBOX_MEMORY_MB,
  SANDBOX_NETWORKS,
  buildSandboxPatch,
  readSandboxConfig,
  type SandboxNetwork,
} from './sandboxConfig';

type LoadState = 'loading' | 'ready' | 'error';
type PrepareState = 'idle' | 'preparing' | 'done' | 'error';

const NETWORK_LABEL_KEYS: Record<SandboxNetwork, I18nKey> = {
  blocked: 'settings.behavior.page.sandbox.network.blocked',
  'allow-all': 'settings.behavior.page.sandbox.network.allowAll',
};

const NETWORK_DESCRIPTION_KEYS: Record<SandboxNetwork, I18nKey> = {
  blocked: 'settings.behavior.page.sandbox.network.blocked.description',
  'allow-all': 'settings.behavior.page.sandbox.network.allowAll.description',
};

type SandboxStatus = {
  supported: boolean;
  installerAvailable: boolean;
  preparing: boolean;
  installedRootfs: string | null;
  configuredRootfs: string | null;
  configuredMissing: boolean;
};

const fetchSandboxStatus = async (): Promise<SandboxStatus> => {
  const response = await fetch(`${opencodeClient.getBaseUrl()}/sandbox/status`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Sandbox status failed (${response.status}).`);
  return response.json();
};

export const SandboxSection: React.FC = () => {
  const { t } = useI18n();
  const [enabled, setEnabled] = React.useState(false);
  const [network, setNetwork] = React.useState<SandboxNetwork>('blocked');
  const [memoryMb, setMemoryMb] = React.useState<number>(DEFAULT_SANDBOX_MEMORY_MB);
  const [cpuCount, setCpuCount] = React.useState<number>(DEFAULT_SANDBOX_CPU_COUNT);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  const [prepareState, setPrepareState] = React.useState<PrepareState>('idle');
  const [status, setStatus] = React.useState<SandboxStatus | null>(null);
  const lastSavedRef = React.useRef<{ enabled: boolean; network: SandboxNetwork; memoryMb: number; cpuCount: number } | null>(null);

  const loadAll = React.useCallback(async (signal: AbortSignal) => {
    try {
      const [config, statusResult] = await Promise.all([
        opencodeClient.getConfig(),
        fetchSandboxStatus(),
      ]);
      if (signal.aborted) return;
      const next = readSandboxConfig(config);
      lastSavedRef.current = next;
      setEnabled(next.enabled);
      setNetwork(next.network);
      setMemoryMb(next.memoryMb);
      setCpuCount(next.cpuCount);
      setStatus(statusResult);
      // If the runtime is already installed, reflect that in the prepare button.
      if (statusResult.installedRootfs) setPrepareState('done');
      setLoadState('ready');
    } catch (error) {
      if (signal.aborted) return;
      console.warn('Failed to load sandbox settings:', error);
      setLoadState('error');
    }
  }, []);

  React.useEffect(() => {
    const abort = new AbortController();
    void loadAll(abort.signal);
    return () => abort.abort();
  }, [loadAll]);

  const handlePrepare = async () => {
    if (prepareState === 'preparing') return;
    setPrepareState('preparing');
    try {
      const response = await fetch(`${opencodeClient.getBaseUrl()}/sandbox/prepare`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string; baseRootfs?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || `Sandbox prepare failed (${response.status}).`);
      }
      // Refresh status so configuredRootfs reflects the server-side write.
      const refreshed = await fetchSandboxStatus();
      setStatus(refreshed);
      setPrepareState('done');
      toast.success(t('settings.behavior.page.sandbox.toast.prepared'));
    } catch (error) {
      console.error('Failed to prepare sandbox runtime:', error);
      setPrepareState('error');
      toast.error(error instanceof Error ? error.message : t('settings.behavior.page.sandbox.toast.prepareFailed'));
    }
  };

  // Debounced autosave for network/memory/cpu. Enabled toggle saves immediately
  // so the user sees the switch flip only after the server acknowledges it.
  React.useEffect(() => {
    if (loadState !== 'ready') return;
    const last = lastSavedRef.current;
    if (
      last
      && last.network === network
      && last.memoryMb === memoryMb
      && last.cpuCount === cpuCount
    ) {
      return;
    }
    const timer = setTimeout(async () => {
      try {
        await opencodeClient.updateConfig(buildSandboxPatch({ network, memoryMb, cpuCount }));
        lastSavedRef.current = {
          enabled: lastSavedRef.current?.enabled ?? false,
          network,
          memoryMb,
          cpuCount,
        };
      } catch (error) {
        console.error('Failed to save sandbox config:', error);
        const fallback = lastSavedRef.current;
        if (fallback) {
          setNetwork(fallback.network);
          setMemoryMb(fallback.memoryMb);
          setCpuCount(fallback.cpuCount);
        }
        toast.error(t('settings.behavior.page.sandbox.toast.saveFailed'));
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [network, memoryMb, cpuCount, loadState, t]);

  const handleEnabledChange = (nextEnabled: boolean) => {
    if (loadState !== 'ready') return;
    // Block enabling until the runtime is prepared; the server would fail
    // closed anyway, but UX is clearer if the toggle refuses to flip.
    if (nextEnabled && !status?.installedRootfs) {
      toast.error(t('settings.behavior.page.sandbox.toast.runtimeMissing'));
      return;
    }
    const previous = lastSavedRef.current?.enabled ?? false;
    setEnabled(nextEnabled);
    void (async () => {
      try {
        await opencodeClient.updateConfig(buildSandboxPatch({ enabled: nextEnabled }));
        lastSavedRef.current = {
          enabled: nextEnabled,
          network: lastSavedRef.current?.network ?? 'blocked',
          memoryMb: lastSavedRef.current?.memoryMb ?? DEFAULT_SANDBOX_MEMORY_MB,
          cpuCount: lastSavedRef.current?.cpuCount ?? DEFAULT_SANDBOX_CPU_COUNT,
        };
        toast.success(t('settings.behavior.page.sandbox.toast.saved'));
      } catch (error) {
        console.error('Failed to save sandbox enabled:', error);
        setEnabled(previous);
        toast.error(t('settings.behavior.page.sandbox.toast.saveFailed'));
      }
    })();
  };

  const controlsDisabled = loadState !== 'ready';
  const runtimeReady = Boolean(status?.installedRootfs);
  const platformUnsupported = loadState === 'ready' && status?.supported === false;

  return (
    <div data-settings-item="behavior.sandbox">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.behavior.page.section.sandbox')}
          </h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              {t('settings.behavior.page.sandbox.tooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-3">
        {platformUnsupported && (
          <p className="typography-small text-[var(--status-error)]">
            {t('settings.behavior.page.sandbox.unsupported')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handlePrepare}
            disabled={controlsDisabled || prepareState === 'preparing' || platformUnsupported}
            size="xs"
            variant={runtimeReady ? 'outline' : 'default'}
            className="!font-normal"
          >
            {prepareState === 'preparing'
              ? t('settings.behavior.page.sandbox.prepare.preparing')
              : runtimeReady
                ? t('settings.behavior.page.sandbox.prepare.reprepare')
                : t('settings.behavior.page.sandbox.prepare.action')}
          </Button>
          {runtimeReady ? (
            <span className="inline-flex items-center gap-1 typography-small text-muted-foreground">
              <Icon name="check" className="h-3 w-3 text-[var(--status-success)]" />
              {t('settings.behavior.page.sandbox.prepare.ready')}
            </span>
          ) : (
            <span className="typography-small text-muted-foreground">
              {t('settings.behavior.page.sandbox.prepare.notReady')}
            </span>
          )}
        </div>

        <label className="flex items-center gap-2 typography-ui-label text-foreground">
          <Checkbox
            checked={enabled}
            onChange={handleEnabledChange}
            disabled={controlsDisabled || !runtimeReady}
            ariaLabel={t('settings.behavior.page.sandbox.enableAria')}
          />
          {t('settings.behavior.page.sandbox.enable')}
        </label>

        <div
          role="radiogroup"
          aria-label={t('settings.behavior.page.sandbox.network.groupAria')}
          className="space-y-1"
        >
          {SANDBOX_NETWORKS.map((option) => {
            const selected = network === option;
            return (
              <div
                key={option}
                role="button"
                tabIndex={controlsDisabled ? -1 : 0}
                aria-pressed={selected}
                aria-disabled={controlsDisabled}
                onClick={() => !controlsDisabled && setNetwork(option)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    if (!controlsDisabled) setNetwork(option);
                  }
                }}
                className={cn(
                  'flex items-start gap-2 py-1',
                  controlsDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                <Radio
                  checked={selected}
                  onChange={() => setNetwork(option)}
                  disabled={controlsDisabled}
                  ariaLabel={t(NETWORK_LABEL_KEYS[option])}
                  className="mt-[3px]"
                />
                <div className="flex min-w-0 flex-col">
                  <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-foreground/50')}>
                    {t(NETWORK_LABEL_KEYS[option])}
                  </span>
                  <span className="typography-small text-muted-foreground">
                    {t(NETWORK_DESCRIPTION_KEYS[option])}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.behavior.page.sandbox.memory.label')}
            </label>
            <div className="flex items-center gap-2">
              <NumberInput
                value={memoryMb}
                onValueChange={setMemoryMb}
                min={MIN_SANDBOX_MEMORY_MB}
                max={MAX_SANDBOX_MEMORY_MB}
                step={256}
                disabled={controlsDisabled}
                className="h-7 w-28"
              />
              <span className="typography-small text-muted-foreground">MB</span>
            </div>
            <p className="typography-small text-muted-foreground">
              {t('settings.behavior.page.sandbox.memory.help', { min: MIN_SANDBOX_MEMORY_MB, max: MAX_SANDBOX_MEMORY_MB })}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.behavior.page.sandbox.cpu.label')}
            </label>
            <div className="flex items-center gap-2">
              <NumberInput
                value={cpuCount}
                onValueChange={setCpuCount}
                min={MIN_SANDBOX_CPU_COUNT}
                max={MAX_SANDBOX_CPU_COUNT}
                step={1}
                disabled={controlsDisabled}
                className="h-7 w-28"
              />
              <span className="typography-small text-muted-foreground">vCPU</span>
            </div>
            <p className="typography-small text-muted-foreground">
              {t('settings.behavior.page.sandbox.cpu.help', { min: MIN_SANDBOX_CPU_COUNT, max: MAX_SANDBOX_CPU_COUNT })}
            </p>
          </div>
        </div>

        {loadState === 'error' && (
          <p className="typography-small text-[var(--status-error)]">
            {t('settings.behavior.page.sandbox.loadError')}
          </p>
        )}
      </section>
    </div>
  );
};
