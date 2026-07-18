export type HitlApprovalMode = 'ask' | 'smart' | 'auto';

export const HITL_APPROVAL_MODES: readonly HitlApprovalMode[] = ['ask', 'smart', 'auto'];

export const DEFAULT_HITL_APPROVAL_MODE: HitlApprovalMode = 'smart';

type HitlApprovalConfig = {
  mode: HitlApprovalMode;
  reviewModel: string;
};

export const sanitizeHitlApprovalMode = (value: unknown): HitlApprovalMode => {
  return value === 'ask' || value === 'smart' || value === 'auto' ? value : DEFAULT_HITL_APPROVAL_MODE;
};

export const sanitizeHitlReviewModel = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

export const readHitlApprovalConfig = (config: unknown): HitlApprovalConfig => {
  const record = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  return {
    mode: sanitizeHitlApprovalMode(record._fe_hitlMode),
    reviewModel: sanitizeHitlReviewModel(record._fe_hitlReviewModel),
  };
};

export const buildHitlReviewModelPatch = (reviewModel: string): { _fe_hitlReviewModel: string | null } => {
  const trimmed = reviewModel.trim();
  return { _fe_hitlReviewModel: trimmed.length > 0 ? trimmed : null };
};
