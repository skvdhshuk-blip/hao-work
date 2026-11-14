import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCheckboxRow, SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { Model, Provider } from '@/lib/opencode/model';

type RouteStrategy = 'order' | 'rotate' | 'priority';

type RouteMember = {
  providerID: string;
  modelID: string;
  priority: number;
};

type ProviderRoute = {
  enabled: boolean;
  preferRoute: boolean;
  strategy: RouteStrategy;
  cursor: number;
  members: RouteMember[];
};

const EMPTY_ROUTE: ProviderRoute = {
  enabled: false,
  preferRoute: false,
  strategy: 'order',
  cursor: 0,
  members: [],
};

const isRoute = (value: unknown): value is ProviderRoute => {
  if (!value || typeof value !== 'object') return false;
  const route = value as Partial<ProviderRoute>;
  return Array.isArray(route.members) && (route.strategy === 'order' || route.strategy === 'rotate' || route.strategy === 'priority');
};

const modelIds = (provider: Provider & { models: Model[] }): string[] => (
  provider.models.map((model) => model.id).filter(Boolean)
);

/**
 * Magpie-style provider route: an ordered list HaoCode walks when the chat's
 * model has no key, or on every message when the user prefers the route.
 */
export const ProviderRouteSection: React.FC<{
  providers: readonly (Provider & { models: Model[] })[];
}> = ({ providers }) => {
  const { t } = useI18n();
  const [route, setRoute] = React.useState<ProviderRoute | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void runtimeFetch('/api/haocode/provider-route', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json();
        return isRoute(payload) ? payload : EMPTY_ROUTE;
      })
      .then((payload) => {
        if (!cancelled && payload) setRoute(payload);
      })
      .catch(() => {
        // A server that is not HaoCode has no route. The provider grid still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = React.useCallback(async (next: ProviderRoute) => {
    setRoute(next);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/haocode/provider-route', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error('save failed');
      const saved = await response.json();
      if (isRoute(saved)) setRoute(saved);
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
    }
  }, []);

  if (!route) return null;

  const usable = providers.filter((provider) => modelIds(provider).length > 0);
  const addMember = () => {
    const provider = usable[0];
    const modelID = provider ? modelIds(provider)[0] : '';
    if (!provider || !modelID) return;
    void save({
      ...route,
      members: [...route.members, { providerID: provider.id, modelID, priority: 0 }],
    });
  };
  const patchMember = (index: number, patch: Partial<RouteMember>) => {
    const members = route.members.map((member, memberIndex) => (
      memberIndex === index ? { ...member, ...patch } : member
    ));
    void save({ ...route, members });
  };
  const moveMember = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= route.members.length) return;
    const members = [...route.members];
    const [moved] = members.splice(index, 1);
    members.splice(nextIndex, 0, moved);
    void save({ ...route, members });
  };

  return (
    <SettingsSection
      title={t('settings.providers.route.title')}
      info={t('settings.providers.route.info')}
      settingsItem="providers.route"
      contentClassName="space-y-1"
    >
      <SettingsCheckboxRow
        checked={route.enabled}
        onChange={(enabled) => void save({ ...route, enabled })}
        label={t('settings.providers.route.enabled')}
      />
      <SettingsCheckboxRow
        checked={route.preferRoute}
        disabled={!route.enabled}
        onChange={(preferRoute) => void save({ ...route, preferRoute })}
        label={t('settings.providers.route.prefer')}
        info={t('settings.providers.route.preferInfo')}
      />
      <SettingsFieldRow label={t('settings.providers.route.strategy')}>
        <Select
          value={route.strategy}
          onValueChange={(strategy) => void save({ ...route, strategy: strategy as RouteStrategy })}
          disabled={!route.enabled}
        >
          <SelectTrigger className="h-9 w-56" aria-label={t('settings.providers.route.strategy')}>
            <SelectValue>{t(`settings.providers.route.strategy.${route.strategy}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="order">{t('settings.providers.route.strategy.order')}</SelectItem>
            <SelectItem value="rotate">{t('settings.providers.route.strategy.rotate')}</SelectItem>
            <SelectItem value="priority">{t('settings.providers.route.strategy.priority')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {route.members.length === 0 ? (
        <p className="py-2 typography-meta text-muted-foreground">{t('settings.providers.route.empty')}</p>
      ) : route.members.map((member, index) => {
        const provider = providers.find((item) => item.id === member.providerID);
        const models = provider ? modelIds(provider) : [];
        const modelOptions = models.includes(member.modelID) ? models : [member.modelID, ...models];
        return (
          <div key={`${member.providerID}-${member.modelID}-${index}`} className="flex flex-wrap items-center gap-2 py-1">
            <Select
              value={member.providerID}
              onValueChange={(providerID) => {
                const nextProvider = providers.find((item) => item.id === providerID);
                const nextModel = nextProvider ? modelIds(nextProvider)[0] : '';
                patchMember(index, { providerID, modelID: nextModel || member.modelID });
              }}
            >
              <SelectTrigger className="h-9 w-40" aria-label={t('settings.providers.route.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={member.modelID} onValueChange={(modelID) => patchMember(index, { modelID })}>
              <SelectTrigger className="h-9 w-52" aria-label={t('settings.providers.route.model')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((modelID) => (
                  <SelectItem key={modelID} value={modelID}>{modelID}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {route.strategy === 'priority' ? (
              <Select
                value={String(member.priority)}
                onValueChange={(priority) => patchMember(index, { priority: Number(priority) })}
              >
                <SelectTrigger className="h-9 w-28" aria-label={t('settings.providers.route.priority')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 5, 10].map((priority) => (
                    <SelectItem key={priority} value={String(priority)}>{t('settings.providers.route.priorityValue', { priority })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => moveMember(index, -1)} disabled={index === 0}>
              {t('settings.providers.route.up')}
            </Button>
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => moveMember(index, 1)} disabled={index === route.members.length - 1}>
              {t('settings.providers.route.down')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void save({ ...route, members: route.members.filter((_, memberIndex) => memberIndex !== index) })}
            >
              {t('settings.providers.route.remove')}
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={addMember} disabled={usable.length === 0}>
        {t('settings.providers.route.add')}
      </Button>
    </SettingsSection>
  );
};
