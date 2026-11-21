import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { buildHitlReviewModelPatch, HitlApprovalMode } from './hitlApproval';
import type { buildSandboxPatch } from './sandboxConfig';

type BehaviorConfigPatch = ReturnType<typeof buildHitlReviewModelPatch>
  | { _fe_hitlMode: HitlApprovalMode }
  | ReturnType<typeof buildSandboxPatch>;

export async function saveHaoCodeBehaviorConfig(patch: BehaviorConfigPatch): Promise<void> {
  const response = await runtimeFetch('/api/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`HaoCode config update failed (${response.status})`);
  opencodeClient.clearConfigCache();
}
