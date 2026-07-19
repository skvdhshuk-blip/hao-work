import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';

// Compact shield badge for the chat header subtitle row that lights up when
// the project has sandbox execution enabled. Mirrors the data path used by
// ChatInput's PermissionAutoAcceptButton: read _fe_sandboxEnabled straight
// from opencode config. Polls lightly while mounted so enabling the sandbox
// in Settings is reflected without a reload.
const POLL_INTERVAL_MS = 5000;

export const SandboxStatusBadge: React.FC = () => {
  const { t } = useI18n();
  const [enabled, setEnabled] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const config = await opencodeClient.getConfig();
        if (cancelled) return;
        setEnabled((config as { _fe_sandboxEnabled?: unknown })._fe_sandboxEnabled === true);
      } catch {
        // Swallow: config may be transiently unavailable during startup.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!enabled) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-0.5 text-[var(--status-success)]"
          aria-label={t('chat.sandboxBadge.tooltip')}
        >
          <Icon name="shield" className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{t('chat.sandboxBadge.label')}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={8} className="max-w-xs">
        {t('chat.sandboxBadge.tooltip')}
      </TooltipContent>
    </Tooltip>
  );
};
