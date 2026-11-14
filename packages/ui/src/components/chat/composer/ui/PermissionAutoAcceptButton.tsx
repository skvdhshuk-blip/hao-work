/**
 * Cycles how this session answers tool permissions: ask, safety net, accept
 * everything. The safety net is left out of the cycle while no classification
 * provider can run it.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard: on
 * Android's resizes-content viewport the keyboard-close relayout moves this
 * button mid-tap and the click never lands.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { cn } from '@/lib/utils';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    /** Already passed through `displayedPermissionMode`. */
    permissionMode: PermissionMode;
    handlePermissionModeCycle: () => void;
    withTooltip?: boolean;
};

const MODE_ICON = {
    ask: { icon: 'shield-user', color: undefined },
    safety: { icon: 'shield-star', color: 'var(--status-success)' },
    auto: { icon: 'shield-check', color: 'var(--status-info)' },
} satisfies Record<PermissionMode, { icon: IconName; color: string | undefined }>;

export const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        permissionMode,
        handlePermissionModeCycle,
        withTooltip = false,
    } = props;

    const label = permissionMode === 'safety'
        ? t('chat.chatInput.permissionMode.safety')
        : permissionMode === 'auto'
            ? t('chat.chatInput.permissionMode.auto')
            : t('chat.chatInput.permissionMode.ask');
    const { icon, color } = MODE_ICON[permissionMode];

    const button = (
        <button
            type="button"
            onClick={handlePermissionModeCycle}
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
            aria-label={label}
            {...(withTooltip ? {} : { title: label })}
        >
            <Icon name={icon} className={cn(iconSizeClass)} style={color ? { color } : undefined} />
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
                <TooltipLabelWithShortcut label={label} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_permission_auto_accept', shortcutOverrides), '')} />
            </TooltipContent>
        </Tooltip>
    );
});
