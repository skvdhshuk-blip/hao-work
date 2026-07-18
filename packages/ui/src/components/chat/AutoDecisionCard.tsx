import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { AutoDecisionRecord } from '@/sync/types';

// Resolved-state companion to PermissionCard: renders one HaoCode smart-mode
// auto decision (audit trail only — no actions).
const KEYS = {
  approved: 'chat.autoDecisionCard.approved',
  rejected: 'chat.autoDecisionCard.rejected',
  sourceRule: 'chat.autoDecisionCard.source.rule',
  sourceReview: 'chat.autoDecisionCard.source.review',
  sourceSandbox: 'chat.autoDecisionCard.source.sandbox',
  risk: 'chat.autoDecisionCard.risk',
} as const;

interface AutoDecisionCardProps {
  record: AutoDecisionRecord;
}

const RISK_TONE: Record<AutoDecisionRecord['riskLevel'], string | undefined> = {
  low: undefined,
  medium: undefined,
  high: 'var(--status-warning)',
  critical: 'var(--status-error)',
};

export const AutoDecisionCard: React.FC<AutoDecisionCardProps> = ({ record }) => {
  const { t } = useI18n();
  const approved = record.decision === 'approve';
  const tone = approved ? 'var(--status-success)' : 'var(--status-error)';
  const riskTone = RISK_TONE[record.riskLevel];

  const title = approved ? t(KEYS.approved) : t(KEYS.rejected);
  const sourceLabel = record.source === 'review'
    ? t(KEYS.sourceReview)
    : record.source === 'sandbox'
      ? t(KEYS.sourceSandbox)
      : t(KEYS.sourceRule);
  const riskLabel = t(KEYS.risk, { level: record.riskLevel });

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <Icon
                  name={approved ? 'shield-check' : 'close-circle'}
                  className="h-3.5 w-3.5 flex-shrink-0"
                  style={{ color: tone }}
                />
                <span className="typography-meta font-medium" style={{ color: tone }}>
                  {title}
                </span>
                <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5 inline-flex items-center gap-1">
                  {record.source === 'sandbox' ? (
                    <Icon name="shield" className="h-2.5 w-2.5 flex-shrink-0" />
                  ) : null}
                  {sourceLabel}
                </span>
                <span
                  className="typography-micro px-1.5 py-0.5 rounded bg-foreground/5"
                  style={{ color: riskTone ?? 'var(--muted-foreground)' }}
                >
                  {riskLabel}
                </span>
              </div>
              <span className="typography-meta text-muted-foreground font-medium flex-shrink-0">
                {record.permission}
              </span>
            </div>
            {record.reason ? (
              <div className="typography-meta text-muted-foreground mt-1 break-words">
                {record.reason}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
