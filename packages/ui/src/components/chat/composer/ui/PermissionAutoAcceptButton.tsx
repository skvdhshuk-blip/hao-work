/**
 * Toggles whether tool permissions are auto-accepted for this session.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard: on
 * Android's resizes-content viewport the keyboard-close relayout moves this
 * button mid-tap and the click never lands.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { cn } from '@/lib/utils';
import {
    DEFAULT_HITL_APPROVAL_MODE,
    HITL_APPROVAL_MODES,
    readHitlApprovalConfig,
    type HitlApprovalMode,
} from '@/components/sections/behavior/hitlApproval';

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    permissionAutoAcceptEnabled: boolean;
    handlePermissionAutoAcceptToggle: () => void;
    withTooltip?: boolean;
};

const HITL_MODE_LABEL_KEYS: Record<HitlApprovalMode, I18nKey> = {
    ask: 'settings.behavior.page.toolApproval.option.ask',
    smart: 'settings.behavior.page.toolApproval.option.smart',
    auto: 'settings.behavior.page.toolApproval.option.auto',
};

const HITL_MODE_DESCRIPTION_KEYS: Record<HitlApprovalMode, I18nKey> = {
    ask: 'settings.behavior.page.toolApproval.option.ask.description',
    smart: 'settings.behavior.page.toolApproval.option.smart.description',
    auto: 'settings.behavior.page.toolApproval.option.auto.description',
};

const HITL_MODE_STATUS_KEYS: Record<HitlApprovalMode, I18nKey> = {
    ask: 'chat.chatInput.permissionAutoAccept.mode.ask',
    smart: 'chat.chatInput.permissionAutoAccept.mode.smart',
    auto: 'chat.chatInput.permissionAutoAccept.mode.auto',
};

const HITL_MODE_ICON: Record<HitlApprovalMode, { name: 'shield-user' | 'shield-check' | 'flashlight'; color?: string }> = {
    ask: { name: 'shield-user' },
    smart: { name: 'shield-check', color: 'var(--status-info)' },
    auto: { name: 'flashlight', color: 'var(--status-warning)' },
};

export const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        permissionAutoAcceptEnabled,
        handlePermissionAutoAcceptToggle,
        withTooltip = false,
    } = props;

    // Keep the Hao Work HITL mode local to this button so composer keystrokes
    // do not re-render ChatInput when the mode menu is opened or changed.
    const [hitlMode, setHitlMode] = React.useState<HitlApprovalMode>(DEFAULT_HITL_APPROVAL_MODE);
    const [hitlLoadState, setHitlLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
    const lastSavedHitlModeRef = React.useRef<HitlApprovalMode | null>(null);

    React.useEffect(() => {
        const abort = new AbortController();

        const load = async () => {
            try {
                const config = await opencodeClient.getConfig();
                if (abort.signal.aborted) return;
                const nextMode = readHitlApprovalConfig(config).mode;
                lastSavedHitlModeRef.current = nextMode;
                setHitlMode(nextMode);
                setHitlLoadState('ready');
            } catch (error) {
                if (abort.signal.aborted) return;
                console.warn('Failed to load tool approval mode:', error);
                setHitlLoadState('error');
            }
        };

        void load();
        return () => abort.abort();
    }, []);

    const handleHitlModeChange = React.useCallback((nextMode: HitlApprovalMode) => {
        if (hitlLoadState !== 'ready' || nextMode === hitlMode) return;
        const previousMode = lastSavedHitlModeRef.current ?? DEFAULT_HITL_APPROVAL_MODE;
        setHitlMode(nextMode);
        void (async () => {
            try {
                await opencodeClient.updateConfig({ _fe_hitlMode: nextMode });
                lastSavedHitlModeRef.current = nextMode;
                toast.success(t('settings.behavior.page.toolApproval.toast.saved'));
            } catch (error) {
                console.error('Failed to save tool approval mode:', error);
                setHitlMode((current) => (current === nextMode ? previousMode : current));
                toast.error(t('settings.behavior.page.toolApproval.toast.saveFailed'));
            }
        })();
    }, [hitlLoadState, hitlMode, t]);

    const statusLabel = t(HITL_MODE_STATUS_KEYS[hitlMode]);
    const modeIcon = HITL_MODE_ICON[hitlMode];

    const button = (
        <button
            type="button"
            className={cn(
                footerIconButtonClass,
                'relative rounded-md hover:bg-transparent',
                !isInteractive && 'opacity-30',
            )}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-label={statusLabel}
            title={statusLabel}
        >
            <Icon
                name={modeIcon.name}
                className={cn(iconSizeClass)}
                style={modeIcon.color ? { color: modeIcon.color } : undefined}
            />
            {permissionAutoAcceptEnabled ? (
                <span
                    aria-hidden="true"
                    className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
                />
            ) : null}
        </button>
    );

    const menu = (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {button}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64">
                <DropdownMenuLabel>
                    {t('settings.behavior.page.section.toolApproval')}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                    value={hitlMode}
                    onValueChange={(value) => {
                        if (value === 'ask' || value === 'smart' || value === 'auto') {
                            handleHitlModeChange(value);
                        }
                    }}
                >
                    {HITL_APPROVAL_MODES.map((option) => (
                        <DropdownMenuRadioItem
                            key={option}
                            value={option}
                            disabled={hitlLoadState !== 'ready'}
                        >
                            <span className="flex min-w-0 flex-col">
                                <span>{t(HITL_MODE_LABEL_KEYS[option])}</span>
                                <span className="typography-small text-muted-foreground">
                                    {t(HITL_MODE_DESCRIPTION_KEYS[option])}
                                </span>
                            </span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    className="items-start pr-8"
                    onSelect={() => {
                        handlePermissionAutoAcceptToggle();
                    }}
                >
                    <span className="flex min-w-0 flex-col">
                        <span>{t('chat.chatInput.permissionAutoAccept.directory')}</span>
                        <span className="typography-small text-muted-foreground">
                            {t('chat.chatInput.permissionAutoAccept.directory.description')}
                        </span>
                    </span>
                    {permissionAutoAcceptEnabled ? (
                        <span className="pointer-events-none absolute right-2 top-1/2 flex size-3.5 -translate-y-1/2 items-center justify-center text-primary">
                            <Icon name="check" className="size-3" />
                        </span>
                    ) : null}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );

    if (!withTooltip) {
        return menu;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">
                    {menu}
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {statusLabel}
            </TooltipContent>
        </Tooltip>
    );
});
