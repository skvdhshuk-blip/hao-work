import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  isOAuthAuthSource,
  normalizeAuthType,
  parseAuthPayload,
  parseOAuthAuthorizePayload,
  type AuthMethod,
  type OAuthAuthorizeDetails,
} from './providerOAuth';
import { QuotaCredentials } from './QuotaCredentials';
import {
  buildCustomProviderBody,
  buildHaoCodeSettingsPatch,
  buildModelImagePolicyPatch,
  DEFAULT_CUSTOM_PROVIDER_TYPE,
  DEFAULT_IMAGE_POLICY,
  extractCreatedProviderId,
  IMAGE_POLICIES,
  isImageVlmModelMissing,
  normalizeImagePolicy,
  normalizeModelImagePolicies,
  parsePositiveIntOverride,
  parseProvidersPayload,
  resolveModelImagePolicy,
  settingsNumberToInput,
  settingsVlmModelToInput,
  type ImagePolicy,
  type ModelImagePolicies,
  type ProviderOption,
  type ProviderSources,
} from './providerSettings';

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const ADD_PROVIDER_ID = '__add_provider__';

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const [authMethodsByProvider, setAuthMethodsByProvider] = React.useState<Record<string, AuthMethod[]>>({});
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, OAuthAuthorizeDetails>>({});
  const [oauthConnectedProviderIds, setOauthConnectedProviderIds] = React.useState<ReadonlySet<string>>(new Set());
  const [availableProviders, setAvailableProviders] = React.useState<ProviderOption[]>([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [availableError, setAvailableError] = React.useState<string | null>(null);
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const [haoCodeBaseUrl, setHaoCodeBaseUrl] = React.useState('');
  const [haoCodeProviderType, setHaoCodeProviderType] = React.useState('');
  const [haoCodeModel, setHaoCodeModel] = React.useState('');
  const [haoCodeContextWindow, setHaoCodeContextWindow] = React.useState('');
  const [haoCodeMaxTokens, setHaoCodeMaxTokens] = React.useState('');
  const [haoCodeImagePolicy, setHaoCodeImagePolicy] = React.useState<ImagePolicy>(DEFAULT_IMAGE_POLICY);
  const [haoCodeImageVlmModel, setHaoCodeImageVlmModel] = React.useState('');
  const [haoCodeSettingsBusy, setHaoCodeSettingsBusy] = React.useState(false);
  const [modelImagePolicies, setModelImagePolicies] = React.useState<ModelImagePolicies>({});
  const [modelImagePolicyBusy, setModelImagePolicyBusy] = React.useState<string | null>(null);
  const [customName, setCustomName] = React.useState('');
  const [customBaseUrl, setCustomBaseUrl] = React.useState('');
  const [customProviderType, setCustomProviderType] = React.useState('');
  const [customApiKey, setCustomApiKey] = React.useState('');
  const [customModels, setCustomModels] = React.useState('');
  const [customContextWindow, setCustomContextWindow] = React.useState('');
  const [customMaxTokens, setCustomMaxTokens] = React.useState('');
  const [customBusy, setCustomBusy] = React.useState(false);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  React.useEffect(() => {
    let isMounted = true;

    const loadAuthMethods = async () => {
      setAuthLoading(true);
      try {
        const result = await opencodeClient.getSdkClient().provider.auth();
        if (result.error) {
          throw new Error(`provider.auth failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAuthMethodsByProvider(parseAuthPayload(result.data));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider auth methods:', error);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadAuthMethods();

    return () => {
      isMounted = false;
    };
  }, [t]);

  React.useEffect(() => {
    if (!shouldLoadAvailableProviders(isAddMode)) {
      return;
    }

    let isMounted = true;

    const loadAvailableProviders = async () => {
      setAvailableLoading(true);
      setAvailableError(null);
      try {
        const result = await opencodeClient.getSdkClient().provider.list();
        if (result.error) {
          throw new Error(`provider.list failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAvailableProviders(parseProvidersPayload(result.data));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load available providers:', error);
        setAvailableError(t('settings.providers.page.state.unableToLoadProviderList'));
      } finally {
        if (isMounted) {
          setAvailableLoading(false);
        }
      }
    };

    loadAvailableProviders();

    return () => {
      isMounted = false;
    };
  }, [isAddMode, t]);

  const connectedProviderIds = React.useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers]
  );

  const unconnectedProviders = React.useMemo(
    () =>
      availableProviders
        .filter((provider) => !connectedProviderIds.has(provider.id))
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [availableProviders, connectedProviderIds]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID) {
      return;
    }

    if (candidateProviderId && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, t]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) return;
    let cancelled = false;
    void runtimeFetch(`/api/provider/${encodeURIComponent(selectedProviderId)}/settings`, {
      headers: { Accept: 'application/json' },
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Failed to load HaoCode provider settings.');
      if (cancelled) return;
      setHaoCodeBaseUrl(typeof payload?.baseUrl === 'string' ? payload.baseUrl : '');
      setHaoCodeProviderType(typeof payload?.providerType === 'string' ? payload.providerType : '');
      setHaoCodeModel('');
      setHaoCodeContextWindow(settingsNumberToInput(payload?.contextWindow));
      setHaoCodeMaxTokens(settingsNumberToInput(payload?.maxTokens));
      setHaoCodeImagePolicy(normalizeImagePolicy(payload?.imagePolicy));
      setHaoCodeImageVlmModel(settingsVlmModelToInput(payload?.imageVlmModel));
      setModelImagePolicies(normalizeModelImagePolicies(payload?.modelImagePolicies));
    }).catch((error) => {
      if (!cancelled) console.error('Failed to load HaoCode provider settings:', error);
    });
    return () => { cancelled = true; };
  }, [selectedProviderId]);

  const loadProviderSources = React.useCallback(async (providerId: string) => {
    try {
      // OpenChamber-only metadata endpoint: the SDK exposes provider data but
      // not local auth/source-file provenance used by this settings UI.
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/source`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
      }

      const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
      if (sources) {
        setProviderSources((prev) => ({
          ...prev,
          [providerId]: sources,
        }));
        setShowAuthPanel(!sources.auth.exists);
      }
    } catch (error) {
      console.error('Failed to load provider sources:', error);
    }
  }, [t]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }

    void loadProviderSources(selectedProviderId);
  }, [selectedProviderId, loadProviderSources]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  const handleSaveApiKey = async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!apiKey) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }

    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const result = await opencodeClient.getSdkClient().auth.set({
        providerID: providerId,
        auth: { type: 'api', key: apiKey },
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.apiKeySaveFailed'));
      }

      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      setSelectedProvider(providerId);
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleSaveHaoCodeSettings = async (providerId: string) => {
    const contextWindowParse = parsePositiveIntOverride(haoCodeContextWindow);
    const maxTokensParse = parsePositiveIntOverride(haoCodeMaxTokens);
    if (contextWindowParse.kind === 'invalid' || maxTokensParse.kind === 'invalid') {
      toast.error(t('settings.providers.page.haocode.invalidNumber'));
      return;
    }
    if (isImageVlmModelMissing(haoCodeImagePolicy, haoCodeImageVlmModel)) {
      toast.error(t('settings.providers.page.haocode.imageVlmModelRequired'));
      return;
    }

    setHaoCodeSettingsBusy(true);
    try {
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/settings`, {
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(buildHaoCodeSettingsPatch({
          baseUrl: haoCodeBaseUrl,
          providerType: haoCodeProviderType,
          model: haoCodeModel,
          contextWindow: haoCodeContextWindow,
          maxTokens: haoCodeMaxTokens,
          imagePolicy: haoCodeImagePolicy,
          imageVlmModel: haoCodeImageVlmModel,
        })),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || t('settings.providers.page.haocode.toast.saveFailed'));
      setHaoCodeBaseUrl(typeof payload?.baseUrl === 'string' ? payload.baseUrl : haoCodeBaseUrl);
      setHaoCodeProviderType(typeof payload?.providerType === 'string' ? payload.providerType : haoCodeProviderType);
      setHaoCodeModel('');
      setHaoCodeContextWindow(settingsNumberToInput(payload?.contextWindow));
      setHaoCodeMaxTokens(settingsNumberToInput(payload?.maxTokens));
      setHaoCodeImagePolicy(normalizeImagePolicy(payload?.imagePolicy));
      setHaoCodeImageVlmModel(settingsVlmModelToInput(payload?.imageVlmModel));
      setModelImagePolicies(normalizeModelImagePolicies(payload?.modelImagePolicies));
      await reloadOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
      toast.success(t('settings.providers.page.haocode.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.haocode.toast.saveFailed'));
    } finally {
      setHaoCodeSettingsBusy(false);
    }
  };

  const handleSaveModelImagePolicy = async (providerId: string, modelId: string, policy: ImagePolicy | null) => {
    const previous = modelImagePolicies;
    const optimistic = { ...previous };
    if (policy === null) delete optimistic[modelId];
    else optimistic[modelId] = policy;
    // Optimistic update; a failed PATCH restores the previous map.
    setModelImagePolicies(optimistic);
    setModelImagePolicyBusy(modelId);
    try {
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/settings`, {
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(buildModelImagePolicyPatch(modelId, policy)),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || t('settings.providers.page.models.imagePolicy.saveFailed'));
      setModelImagePolicies(normalizeModelImagePolicies(payload?.modelImagePolicies));
    } catch (error) {
      setModelImagePolicies(previous);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.models.imagePolicy.saveFailed'));
    } finally {
      setModelImagePolicyBusy(null);
    }
  };

  const handleCreateCustomProvider = async () => {
    const result = buildCustomProviderBody({
      name: customName,
      baseUrl: customBaseUrl,
      providerType: customProviderType,
      apiKey: customApiKey,
      models: customModels,
      contextWindow: customContextWindow,
      maxTokens: customMaxTokens,
    });
    if (!result.ok) {
      if (result.error === 'nameRequired') {
        toast.error(t('settings.providers.page.custom.toast.nameRequired'));
      } else if (result.error === 'baseUrlRequired') {
        toast.error(t('settings.providers.page.custom.toast.baseUrlRequired'));
      } else {
        toast.error(t('settings.providers.page.custom.toast.invalidNumber'));
      }
      return;
    }

    setCustomBusy(true);
    try {
      const response = await runtimeFetch('/api/provider/custom', {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(result.body),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        toast.error(t('settings.providers.page.custom.toast.nameConflict'));
        return;
      }
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.custom.toast.createFailed'));
      }

      const createdId = extractCreatedProviderId(payload);
      toast.success(t('settings.providers.page.custom.toast.created'));
      setCustomName('');
      setCustomBaseUrl('');
      setCustomProviderType('');
      setCustomApiKey('');
      setCustomModels('');
      setCustomContextWindow('');
      setCustomMaxTokens('');
      await reloadOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
      if (createdId) {
        setSelectedProvider(createdId);
      }
    } catch (error) {
      console.error('Failed to create custom provider:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.custom.toast.createFailed'));
    } finally {
      setCustomBusy(false);
    }
  };

  const handleOAuthStart = async (providerId: string, methodIndex: number) => {
    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const result = await opencodeClient.getSdkClient().provider.oauth.authorize({
        providerID: providerId,
        method: methodIndex,
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.oauthStartFailed'));
      }

      const details = parseOAuthAuthorizePayload(result.data);
      if (!details) {
        throw new Error(t('settings.providers.page.toast.oauthDetailsMissing'));
      }

      const detailsKey = `${providerId}:${methodIndex}`;
      setOauthDetails((prev) => ({
        ...prev,
        [detailsKey]: details,
      }));

      if (details.url) {
        void openExternalUrl(details.url);
      }
      setPendingOAuth({ providerId, methodIndex });
      toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));

      // 'auto' flows finish server-side once the browser redirect lands; kick
      // off the callback immediately so the UI can wait on it.
      if (details.method === 'auto') {
        void handleOAuthComplete(providerId, methodIndex);
      }
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
    } finally {
      // Preserve the busy key of an auto-flow callback that was just kicked
      // off; only clear the key this handler set itself.
      setAuthBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const handleOAuthComplete = async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();

    const busyKey = `oauth-complete:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const requestBody: { method: number; code?: string } = { method: methodIndex };
      if (code) {
        requestBody.code = code;
      }

      const result = await opencodeClient.getSdkClient().provider.oauth.callback({
        providerID: providerId,
        method: requestBody.method,
        code: requestBody.code,
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.oauthCompleteFailed'));
      }

      toast.success(t('settings.providers.page.toast.oauthCompleted'));
      setOauthCodes((prev) => ({ ...prev, [codeKey]: '' }));
      setOauthDetails((prev) => {
        const next = { ...prev };
        delete next[codeKey];
        return next;
      });
      setPendingOAuth(null);
      setOauthConnectedProviderIds((prev) => new Set(prev).add(providerId));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviderSources(providerId);
      setSelectedProvider(providerId);
    } catch (error) {
      console.error('Failed to complete OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthCompleteFailed'));
      // 'auto' flows fail when the browser callback is denied or times out;
      // clear the pending state so the waiting indicator does not stick.
      if (oauthDetails[codeKey]?.method === 'auto') {
        setPendingOAuth(null);
      }
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    console.error('Failed to copy OAuth link:', result.error);
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    console.error('Failed to copy device code:', result.error);
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/auth?scope=all`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.providerDisconnectFailed'));
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      setOauthConnectedProviderIds((prev) => {
        if (!prev.has(providerId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
          <div data-settings-item="providers.connect" className="mb-4">
            <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.providers.page.connect.title')}</h1>
          </div>

          <div className="mb-8">
            <div className="mb-1 px-1">
              <h2 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connect.selectProviderTitle')}</h2>
            </div>

            <section className="px-2 pb-2 pt-0">
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                  {availableLoading ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                  ) : availableError ? (
                    <p className="typography-meta text-muted-foreground">{availableError}</p>
                  ) : unconnectedProviders.length === 0 ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.allProvidersConnected')}</p>
                  ) : (
                    <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                      setProviderDropdownOpen(open);
                      if (!open) setProviderSearchQuery('');
                    }}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover h-6 w-fit",
                          )}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {candidateProviderId ? <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                            <span className={cn("truncate typography-ui-label font-normal", candidateProviderId ? "text-foreground" : "text-muted-foreground")}>
                              {candidateProviderId
                                ? (unconnectedProviders.find(p => p.id === candidateProviderId)?.name || candidateProviderId)
                                : t('settings.providers.page.connect.selectProviderPlaceholder')}
                            </span>
                          </span>
                          <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[280px] p-0"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <div
                          className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2"
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="search" className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={providerSearchQuery}
                            onChange={(e) => setProviderSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                            className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                        </div>
                        <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                          {(() => {
                            const filtered = unconnectedProviders.filter(p => {
                              const query = providerSearchQuery.toLowerCase();
                              return (p.name || p.id).toLowerCase().includes(query) || p.id.toLowerCase().includes(query);
                            });
                            if (filtered.length === 0) {
                              return <p className="py-4 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>;
                            }
                            return filtered.map((provider) => (
                              <DropdownMenuItem
                                key={provider.id}
                                onSelect={() => {
                                  setCandidateProviderId(provider.id);
                                  setProviderDropdownOpen(false);
                                  setProviderSearchQuery('');
                                }}
                                className="flex items-center justify-between"
                              >
                                <span className="flex items-center gap-2 min-w-0">
                                  <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                                  <span className="truncate">{provider.name || provider.id}</span>
                                </span>
                                {candidateProviderId === provider.id && (
                                  <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                )}
                              </DropdownMenuItem>
                            ));
                          })()}
                        </ScrollableOverlay>
                      </DropdownMenuContent>
                    </DropdownMenu>
                   )}
              </div>
            </section>
          </div>

          {(() => {
            const customContextWindowInvalid = parsePositiveIntOverride(customContextWindow).kind === 'invalid';
            const customMaxTokensInvalid = parsePositiveIntOverride(customMaxTokens).kind === 'invalid';
            const customOverridesInvalid = customContextWindowInvalid || customMaxTokensInvalid;
            const customDisabled =
              customBusy || customOverridesInvalid || !customName.trim() || !customBaseUrl.trim();

            return (
              <div data-settings-item="providers.custom" className="mb-8">
                <div className="mb-1 px-1">
                  <h2 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.custom.title')}</h2>
                  <p className="typography-meta text-muted-foreground">{t('settings.providers.page.custom.description')}</p>
                </div>
                <section className="grid gap-3 px-2 py-1.5 sm:grid-cols-2">
                  <label className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.custom.nameLabel')}
                    <Input
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      placeholder={t('settings.providers.page.custom.namePlaceholder')}
                      className="mt-1 text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.custom.providerTypeLabel')}
                    <Input
                      value={customProviderType}
                      onChange={(event) => setCustomProviderType(event.target.value)}
                      placeholder={DEFAULT_CUSTOM_PROVIDER_TYPE}
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground sm:col-span-2">
                    {t('settings.providers.page.custom.baseUrlLabel')}
                    <Input
                      value={customBaseUrl}
                      onChange={(event) => setCustomBaseUrl(event.target.value)}
                      placeholder="https://api.example.com"
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground sm:col-span-2">
                    {t('settings.providers.page.custom.apiKeyLabel')}
                    <Input
                      type="password"
                      value={customApiKey}
                      onChange={(event) => setCustomApiKey(event.target.value)}
                      placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground sm:col-span-2">
                    {t('settings.providers.page.custom.modelsLabel')}
                    <Input
                      value={customModels}
                      onChange={(event) => setCustomModels(event.target.value)}
                      placeholder={t('settings.providers.page.custom.modelsPlaceholder')}
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.custom.contextWindowLabel')}
                    <Input
                      value={customContextWindow}
                      onChange={(event) => setCustomContextWindow(event.target.value)}
                      placeholder={t('settings.providers.page.haocode.inheritPlaceholder')}
                      inputMode="numeric"
                      aria-invalid={customContextWindowInvalid}
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  <label className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.custom.maxTokensLabel')}
                    <Input
                      value={customMaxTokens}
                      onChange={(event) => setCustomMaxTokens(event.target.value)}
                      placeholder={t('settings.providers.page.haocode.inheritPlaceholder')}
                      inputMode="numeric"
                      aria-invalid={customMaxTokensInvalid}
                      className="mt-1 font-mono text-xs"
                    />
                  </label>
                  {customOverridesInvalid && (
                    <p className="typography-meta text-[var(--status-error)] sm:col-span-2">
                      {t('settings.providers.page.custom.toast.invalidNumber')}
                    </p>
                  )}
                  <div className="sm:col-span-2">
                    <Button
                      size="xs"
                      className="!font-normal"
                      onClick={() => void handleCreateCustomProvider()}
                      disabled={customDisabled}
                    >
                      {customBusy ? t('settings.providers.page.custom.creating') : t('settings.providers.page.custom.create')}
                    </Button>
                  </div>
                </section>
              </div>
            );
          })()}

          {candidateProviderId && (
            <div data-settings-item="providers.auth" className="mb-8">
              <div className="mb-1 px-1">
                <h2 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h2>
              </div>

              {authLoading ? (
                <p className="typography-meta text-muted-foreground px-2">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <section className="px-2 pb-2 pt-0 space-y-4">
                  <div className="py-1.5">
                    <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                      {t('settings.providers.page.auth.apiKeyLabel')}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent sideOffset={8} className="max-w-xs">
                          {t('settings.providers.page.auth.apiKeyTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    </label>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                      <Input
                        type="password"
                        value={apiKeyInputs[candidateProviderId] ?? ''}
                        onChange={(event) =>
                          setApiKeyInputs((prev) => ({
                            ...prev,
                            [candidateProviderId]: event.target.value,
                          }))
                        }
                        placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={() => handleSaveApiKey(candidateProviderId)}
                        disabled={authBusyKey === `api:${candidateProviderId}`}
                      >
                        {authBusyKey === `api:${candidateProviderId}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                      </Button>
                    </div>
                  </div>

                  {(() => {
                    const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                    const candidateOAuthMethods = candidateAuthMethods.filter(
                      (method) => normalizeAuthType(method) === 'oauth'
                    );

                    if (candidateOAuthMethods.length === 0) {
                      return null;
                    }

                    return (
                      <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                        {candidateOAuthMethods.map((method, index) => {
                          const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                          const codeKey = `${candidateProviderId}:${index}`;
                          const isPending =
                            pendingOAuth?.providerId === candidateProviderId && pendingOAuth?.methodIndex === index;
                          const isAutoFlow = oauthDetails[codeKey]?.method === 'auto';
                          const isAutoWaiting = isPending && isAutoFlow;

                          return (
                            <div key={`${candidateProviderId}-${methodLabel}`} className="space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="typography-ui-label text-foreground">{methodLabel}</div>
                                  {(method.description || method.help) && (
                                    <div className="typography-meta text-muted-foreground">
                                      {String(method.description || method.help)}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="!font-normal"
                                  onClick={() => handleOAuthStart(candidateProviderId, index)}
                                  disabled={authBusyKey === `oauth:${candidateProviderId}:${index}`}
                                >
                                  {t('settings.providers.page.actions.connect')}
                                </Button>
                              </div>

                              {oauthDetails[codeKey]?.instructions && (
                                <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                                  {oauthDetails[codeKey]?.instructions}
                                </p>
                              )}

                              {oauthDetails[codeKey]?.userCode && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                                  <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                                </div>
                              )}

                              {oauthDetails[codeKey]?.url && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                                  <div className="flex gap-1 shrink-0">
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                                  </div>
                                </div>
                              )}

                              {isAutoWaiting && (
                                <div className="flex items-center gap-2 mt-2 rounded bg-[var(--surface-muted)] px-2 py-1.5">
                                  <Icon name="loader-4" className="h-4 w-4 shrink-0 animate-spin text-[var(--primary-base)]" />
                                  <div className="min-w-0">
                                    <div className="typography-meta text-foreground">{t('settings.providers.page.auth.oauthWaitingForBrowser')}</div>
                                    <div className="typography-micro text-muted-foreground">{t('settings.providers.page.auth.oauthWaitingHint')}</div>
                                  </div>
                                </div>
                              )}

                              {isPending && !isAutoFlow && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input
                                    value={oauthCodes[codeKey] ?? ''}
                                    onChange={(event) =>
                                      setOauthCodes((prev) => ({
                                        ...prev,
                                        [codeKey]: event.target.value,
                                      }))
                                    }
                                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                    className="font-mono text-xs"
                                  />
                                  <Button
                                    size="xs"
                                    className="!font-normal"
                                    onClick={() => handleOAuthComplete(candidateProviderId, index)}
                                    disabled={authBusyKey === `oauth-complete:${candidateProviderId}:${index}`}
                                  >
                                    {authBusyKey === `oauth-complete:${candidateProviderId}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </section>
              )}
            </div>
          )}
        </div>
      </ScrollableOverlay>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const providerAuthMethods = authMethodsByProvider[selectedProvider.id] ?? [];
  const oauthAuthMethods = providerAuthMethods.filter((method) => normalizeAuthType(method) === 'oauth');
  const connectedViaOAuth =
    oauthConnectedProviderIds.has(selectedProvider.id) || isOAuthAuthSource(selectedSources?.auth);

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (!query) return true;
    return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
  });

  const haoCodeContextWindowInvalid = parsePositiveIntOverride(haoCodeContextWindow).kind === 'invalid';
  const haoCodeMaxTokensInvalid = parsePositiveIntOverride(haoCodeMaxTokens).kind === 'invalid';
  const haoCodeOverridesInvalid = haoCodeContextWindowInvalid || haoCodeMaxTokensInvalid;
  const haoCodeImageVlmModelMissing = isImageVlmModelMissing(haoCodeImagePolicy, haoCodeImageVlmModel);

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProvider.name || selectedProvider.id}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              <span className="font-mono">{selectedProvider.id}</span>
            </p>
          </div>
        </div>

        {/* Authentication */}
        <div data-settings-item="providers.auth" className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h3>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowAuthPanel((prev) => !prev)}
            >
              {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
            </Button>
          </div>

          <section className="px-2 pb-2 pt-0">
            {!showAuthPanel ? (
              <div className="flex items-center gap-1.5 py-1.5">
                <Icon name="check" className="w-4 h-4 text-[var(--status-success)] shrink-0" />
                <span className="typography-ui-label text-foreground">
                  {connectedViaOAuth
                    ? t('settings.providers.page.auth.connectedViaOAuth')
                    : t('settings.providers.page.auth.connected')}
                </span>
                <span className="typography-meta text-muted-foreground ml-1">{t('settings.providers.page.auth.useReconnectHint')}</span>
              </div>
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                <div className="py-1.5">
                  <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                    {t('settings.providers.page.auth.apiKeyLabel')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8} className="max-w-xs">
                        {t('settings.providers.page.auth.apiKeyTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </label>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                    <Input
                      type="password"
                      value={apiKeyInputs[selectedProvider.id] ?? ''}
                      onChange={(event) =>
                        setApiKeyInputs((prev) => ({
                          ...prev,
                          [selectedProvider.id]: event.target.value,
                        }))
                      }
                      placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                      className="flex-1 font-mono text-xs"
                    />
                    <Button
                      size="xs"
                      className="!font-normal shrink-0"
                      onClick={() => handleSaveApiKey(selectedProvider.id)}
                      disabled={authBusyKey === `api:${selectedProvider.id}`}
                    >
                      {authBusyKey === `api:${selectedProvider.id}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                    </Button>
                  </div>
                </div>

                {oauthAuthMethods.length > 0 && (
                  <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                    {oauthAuthMethods.map((method, index) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                      const codeKey = `${selectedProvider.id}:${index}`;
                      const isPending =
                        pendingOAuth?.providerId === selectedProvider.id && pendingOAuth?.methodIndex === index;
                      const isAutoFlow = oauthDetails[codeKey]?.method === 'auto';
                      const isAutoWaiting = isPending && isAutoFlow;

                      return (
                        <div key={`${selectedProvider.id}-${methodLabel}`} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="typography-ui-label text-foreground">{methodLabel}</div>
                              {(method.description || method.help) && (
                                <div className="typography-meta text-muted-foreground">
                                  {String(method.description || method.help)}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              onClick={() => handleOAuthStart(selectedProvider.id, index)}
                              disabled={authBusyKey === `oauth:${selectedProvider.id}:${index}`}
                            >
                              {t('settings.providers.page.actions.connect')}
                            </Button>
                          </div>

                          {oauthDetails[codeKey]?.instructions && (
                            <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                              {oauthDetails[codeKey]?.instructions}
                            </p>
                          )}

                          {oauthDetails[codeKey]?.userCode && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                              <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                            </div>
                          )}

                          {oauthDetails[codeKey]?.url && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                              <div className="flex gap-1 shrink-0">
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                              </div>
                            </div>
                          )}

                          {isAutoWaiting && (
                            <div className="flex items-center gap-2 mt-2 rounded bg-[var(--surface-muted)] px-2 py-1.5">
                              <Icon name="loader-4" className="h-4 w-4 shrink-0 animate-spin text-[var(--primary-base)]" />
                              <div className="min-w-0">
                                <div className="typography-meta text-foreground">{t('settings.providers.page.auth.oauthWaitingForBrowser')}</div>
                                <div className="typography-micro text-muted-foreground">{t('settings.providers.page.auth.oauthWaitingHint')}</div>
                              </div>
                            </div>
                          )}

                          {isPending && !isAutoFlow && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={oauthCodes[codeKey] ?? ''}
                                onChange={(event) =>
                                  setOauthCodes((prev) => ({
                                    ...prev,
                                    [codeKey]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                className="font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal"
                                onClick={() => handleOAuthComplete(selectedProvider.id, index)}
                                disabled={authBusyKey === `oauth-complete:${selectedProvider.id}:${index}`}
                              >
                                {authBusyKey === `oauth-complete:${selectedProvider.id}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <div data-settings-item="providers.haocode" className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.haocode.title')}</h3>
            <p className="typography-meta text-muted-foreground">{t('settings.providers.page.haocode.description')}</p>
          </div>
          <section className="grid gap-3 px-2 py-1.5 sm:grid-cols-2">
            <label className="typography-meta text-muted-foreground sm:col-span-2">
              {t('settings.providers.page.haocode.baseUrlLabel')}
              <Input
                value={haoCodeBaseUrl}
                onChange={(event) => setHaoCodeBaseUrl(event.target.value)}
                placeholder="https://api.example.com"
                className="mt-1 font-mono text-xs"
              />
            </label>
            <label className="typography-meta text-muted-foreground">
              {t('settings.providers.page.haocode.providerTypeLabel')}
              <Input
                value={haoCodeProviderType}
                onChange={(event) => setHaoCodeProviderType(event.target.value)}
                placeholder="anthropic | openai | openai_chat"
                className="mt-1 font-mono text-xs"
              />
            </label>
            <label className="typography-meta text-muted-foreground">
              {t('settings.providers.page.haocode.addModelLabel')}
              <Input
                value={haoCodeModel}
                onChange={(event) => setHaoCodeModel(event.target.value)}
                placeholder="model-name"
                className="mt-1 font-mono text-xs"
              />
            </label>
            <label className="typography-meta text-muted-foreground">
              {t('settings.providers.page.haocode.contextWindowLabel')}
              <Input
                value={haoCodeContextWindow}
                onChange={(event) => setHaoCodeContextWindow(event.target.value)}
                placeholder={t('settings.providers.page.haocode.inheritPlaceholder')}
                inputMode="numeric"
                aria-invalid={haoCodeContextWindowInvalid}
                className="mt-1 font-mono text-xs"
              />
            </label>
            <label className="typography-meta text-muted-foreground">
              {t('settings.providers.page.haocode.maxTokensLabel')}
              <Input
                value={haoCodeMaxTokens}
                onChange={(event) => setHaoCodeMaxTokens(event.target.value)}
                placeholder={t('settings.providers.page.haocode.inheritPlaceholder')}
                inputMode="numeric"
                aria-invalid={haoCodeMaxTokensInvalid}
                className="mt-1 font-mono text-xs"
              />
            </label>
            <div data-settings-item="providers.haocode.image-policy" className="sm:col-span-2">
              <span className="typography-meta text-muted-foreground">
                {t('settings.providers.page.haocode.imagePolicyLabel')}
              </span>
              <div className="mt-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover h-6 w-fit",
                      )}
                    >
                      <span className="truncate typography-ui-label font-normal text-foreground">
                        {t(`settings.providers.page.haocode.imagePolicy.${haoCodeImagePolicy}`)}
                      </span>
                      <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[260px] p-1">
                    {IMAGE_POLICIES.map((policy) => (
                      <DropdownMenuItem
                        key={policy}
                        onSelect={() => setHaoCodeImagePolicy(policy)}
                        className="flex items-center justify-between"
                      >
                        <span className="truncate">{t(`settings.providers.page.haocode.imagePolicy.${policy}`)}</span>
                        {haoCodeImagePolicy === policy && (
                          <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="typography-meta text-muted-foreground mt-1">
                {t('settings.providers.page.haocode.imagePolicyDescription')}
              </p>
            </div>
            {haoCodeImagePolicy === 'vlm' && (
              <label className="typography-meta text-muted-foreground sm:col-span-2">
                {t('settings.providers.page.haocode.imageVlmModelLabel')}
                <Input
                  value={haoCodeImageVlmModel}
                  onChange={(event) => setHaoCodeImageVlmModel(event.target.value)}
                  placeholder="model-name"
                  aria-invalid={haoCodeImageVlmModelMissing}
                  className="mt-1 font-mono text-xs"
                />
              </label>
            )}
            {haoCodeImageVlmModelMissing && (
              <p className="typography-meta text-[var(--status-error)] sm:col-span-2">
                {t('settings.providers.page.haocode.imageVlmModelRequired')}
              </p>
            )}
            {haoCodeOverridesInvalid && (
              <p className="typography-meta text-[var(--status-error)] sm:col-span-2">
                {t('settings.providers.page.haocode.invalidNumber')}
              </p>
            )}
            <div className="sm:col-span-2">
              <Button
                size="xs"
                className="!font-normal"
                onClick={() => handleSaveHaoCodeSettings(selectedProvider.id)}
                disabled={haoCodeSettingsBusy || haoCodeOverridesInvalid || haoCodeImageVlmModelMissing || !haoCodeBaseUrl.trim() || !haoCodeProviderType.trim()}
              >
                {haoCodeSettingsBusy ? t('settings.providers.page.actions.saving') : t('settings.providers.page.haocode.save')}
              </Button>
            </div>
          </section>
        </div>

        {(selectedProvider.id === 'opencode' || selectedProvider.id === 'opencode-go') && <QuotaCredentials providerId="opencode-go" providerName="OpenCode Go" />}
        {(selectedProvider.id === 'ollama' || selectedProvider.id === 'ollama-cloud') && <QuotaCredentials providerId="ollama-cloud" providerName="Ollama Cloud" />}
        {selectedProvider.id === 'cursor' && <QuotaCredentials providerId="cursor" providerName="Cursor" />}

        {/* Connection Details */}
        <div data-settings-item="providers.connection-details" className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connectionDetails.title')}</h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedSources && (selectedSources.auth.exists || selectedSources.user.exists || selectedSources.project.exists || selectedSources.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              <Button
                variant="ghost"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => handleDisconnectProvider(selectedProvider.id)}
                disabled={authBusyKey === `disconnect:${selectedProvider.id}`}
              >
                {authBusyKey === `disconnect:${selectedProvider.id}` ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
              </Button>
            </div>
          </section>
        </div>

        {/* Models */}
        <div data-settings-item="providers.models" className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.providers.page.models.title')}
              {providerModels.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({providerModels.length})
                </span>
              )}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  const allIds = providerModels
                    .map((model) => (typeof model?.id === 'string' ? model.id : ''))
                    .filter((id) => id.length > 0);
                  hideAllModels(selectedProvider.id, allIds);
                }}
              >
                {t('settings.providers.page.actions.hideAll')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => showAllModels(selectedProvider.id)}
              >
                {t('settings.providers.page.actions.showAll')}
              </Button>
            </div>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="relative mb-2">
              <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}
                className="h-7 pl-8 w-full"
              />
            </div>

            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filteredModels.map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const isHidden = hiddenModels.some(
                    (item) => item.providerID === selectedProvider.id && item.modelID === modelId
                  );

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);

                  const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <div key={modelId} className="py-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-3",
                          isHidden && 'opacity-50',
                        )}
                      >
                      <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                        {modelName}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {(contextTokens || outputTokens) && (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">
                            {contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : ''}
                            {contextTokens && outputTokens ? ' · ' : ''}
                            {outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''}
                          </span>
                        )}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground bg-[var(--surface-muted)]"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                        {modelId && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={modelImagePolicyBusy === modelId}
                                aria-label={t('settings.providers.page.models.imagePolicy.ariaLabel', { model: modelName })}
                                title={t('settings.providers.page.models.imagePolicy.ariaLabel', { model: modelName })}
                                className="flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50 disabled:opacity-50"
                              >
                                <span className="typography-micro whitespace-nowrap">
                                  {t(`settings.providers.page.haocode.imagePolicy.${resolveModelImagePolicy(modelImagePolicies, haoCodeImagePolicy, modelId)}`)}
                                </span>
                                <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-[260px] p-1">
                              <DropdownMenuItem
                                onSelect={() => void handleSaveModelImagePolicy(selectedProvider.id, modelId, null)}
                                className="flex items-center justify-between"
                              >
                                <span className="truncate">
                                  {t('settings.providers.page.models.imagePolicy.inherit', { policy: t(`settings.providers.page.haocode.imagePolicy.${haoCodeImagePolicy}`) })}
                                </span>
                                {!modelImagePolicies[modelId] && (
                                  <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                )}
                              </DropdownMenuItem>
                              {IMAGE_POLICIES.map((policy) => (
                                <DropdownMenuItem
                                  key={policy}
                                  onSelect={() => void handleSaveModelImagePolicy(selectedProvider.id, modelId, policy)}
                                  className="flex items-center justify-between"
                                >
                                  <span className="truncate">{t(`settings.providers.page.haocode.imagePolicy.${policy}`)}</span>
                                  {modelImagePolicies[modelId] === policy && (
                                    <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                  )}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHiddenModel(selectedProvider.id, modelId)}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </ScrollableOverlay>
  );
};
