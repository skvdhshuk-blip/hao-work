import React from 'react';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import {
  DEFAULT_HITL_APPROVAL_MODE,
  HITL_APPROVAL_MODES,
  buildHitlReviewModelPatch,
  readHitlApprovalConfig,
  type HitlApprovalMode,
} from './hitlApproval';

const OPTION_LABEL_KEYS: Record<HitlApprovalMode, I18nKey> = {
  ask: 'settings.behavior.page.toolApproval.option.ask',
  smart: 'settings.behavior.page.toolApproval.option.smart',
  auto: 'settings.behavior.page.toolApproval.option.auto',
};

const OPTION_DESCRIPTION_KEYS: Record<HitlApprovalMode, I18nKey> = {
  ask: 'settings.behavior.page.toolApproval.option.ask.description',
  smart: 'settings.behavior.page.toolApproval.option.smart.description',
  auto: 'settings.behavior.page.toolApproval.option.auto.description',
};

type LoadState = 'loading' | 'ready' | 'error';

export const ToolApprovalSection: React.FC = () => {
  const { t } = useI18n();
  const reviewModelInputId = React.useId();
  const [mode, setMode] = React.useState<HitlApprovalMode>(DEFAULT_HITL_APPROVAL_MODE);
  const [reviewModel, setReviewModel] = React.useState('');
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  const lastSavedRef = React.useRef<{ mode: HitlApprovalMode; reviewModel: string } | null>(null);

  React.useEffect(() => {
    const abort = new AbortController();

    const load = async () => {
      try {
        const config = await opencodeClient.getConfig();
        if (abort.signal.aborted) return;
        const next = readHitlApprovalConfig(config);
        lastSavedRef.current = next;
        setMode(next.mode);
        setReviewModel(next.reviewModel);
        setLoadState('ready');
      } catch (error) {
        if (abort.signal.aborted) return;
        console.warn('Failed to load tool approval settings:', error);
        setLoadState('error');
      }
    };

    void load();
    return () => abort.abort();
  }, []);

  const handleModeChange = (nextMode: HitlApprovalMode) => {
    if (loadState !== 'ready' || nextMode === mode) return;
    const previousMode = lastSavedRef.current?.mode ?? DEFAULT_HITL_APPROVAL_MODE;
    setMode(nextMode);
    void (async () => {
      try {
        await opencodeClient.updateConfig({ _fe_hitlMode: nextMode });
        lastSavedRef.current = {
          mode: nextMode,
          reviewModel: lastSavedRef.current?.reviewModel ?? '',
        };
        toast.success(t('settings.behavior.page.toolApproval.toast.saved'));
      } catch (error) {
        console.error('Failed to save tool approval mode:', error);
        setMode((current) => (current === nextMode ? previousMode : current));
        toast.error(t('settings.behavior.page.toolApproval.toast.saveFailed'));
      }
    })();
  };

  React.useEffect(() => {
    if (loadState !== 'ready') return;
    const trimmed = reviewModel.trim();
    if (lastSavedRef.current && lastSavedRef.current.reviewModel === trimmed) return;

    const timer = setTimeout(async () => {
      const attempted = trimmed;
      try {
        await opencodeClient.updateConfig(buildHitlReviewModelPatch(attempted));
        lastSavedRef.current = {
          mode: lastSavedRef.current?.mode ?? DEFAULT_HITL_APPROVAL_MODE,
          reviewModel: attempted,
        };
        toast.success(t('settings.behavior.page.toolApproval.toast.saved'));
      } catch (error) {
        console.error('Failed to save tool approval review model:', error);
        const fallback = lastSavedRef.current?.reviewModel ?? '';
        setReviewModel((current) => (current.trim() === attempted ? fallback : current));
        toast.error(t('settings.behavior.page.toolApproval.toast.saveFailed'));
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [reviewModel, loadState, t]);

  const controlsDisabled = loadState !== 'ready';

  return (
    <div data-settings-item="behavior.tool-approval">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.behavior.page.section.toolApproval')}
          </h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              {t('settings.behavior.page.toolApproval.tooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-3">
        <div
          role="radiogroup"
          aria-label={t('settings.behavior.page.toolApproval.groupAria')}
          className="space-y-1"
        >
          {HITL_APPROVAL_MODES.map((option) => {
            const selected = mode === option;
            return (
              <div
                key={option}
                role="button"
                tabIndex={controlsDisabled ? -1 : 0}
                aria-pressed={selected}
                aria-disabled={controlsDisabled}
                onClick={() => handleModeChange(option)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    handleModeChange(option);
                  }
                }}
                className={cn(
                  'flex items-start gap-2 py-1',
                  controlsDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                <Radio
                  checked={selected}
                  onChange={() => handleModeChange(option)}
                  disabled={controlsDisabled}
                  ariaLabel={t(OPTION_LABEL_KEYS[option])}
                  className="mt-[3px]"
                />
                <div className="flex min-w-0 flex-col">
                  <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-foreground/50')}>
                    {t(OPTION_LABEL_KEYS[option])}
                  </span>
                  <span className="typography-small text-muted-foreground">
                    {t(OPTION_DESCRIPTION_KEYS[option])}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={reviewModelInputId} className="typography-ui-label text-foreground">
            {t('settings.behavior.page.toolApproval.reviewModel.label')}
          </label>
          <Input
            id={reviewModelInputId}
            value={reviewModel}
            onChange={(event) => setReviewModel(event.target.value)}
            placeholder={t('settings.behavior.page.toolApproval.reviewModel.placeholder')}
            disabled={controlsDisabled || mode !== 'smart'}
            className="h-7 max-w-xs"
          />
          <p className="typography-small text-muted-foreground">
            {t('settings.behavior.page.toolApproval.reviewModel.help')}
          </p>
        </div>

        {loadState === 'error' && (
          <p className="typography-small text-[var(--status-error)]">
            {t('settings.behavior.page.toolApproval.loadError')}
          </p>
        )}
      </section>
    </div>
  );
};
