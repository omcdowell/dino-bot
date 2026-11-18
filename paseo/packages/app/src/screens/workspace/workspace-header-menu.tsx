import React, { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Ellipsis } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedCopy = withUnistyles(Copy);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_COPY_ICON = <ThemedCopy size={16} uniProps={mutedColorMapping} />;

function WorkspaceHeaderMenuTriggerIcon() {
  return (
    <ThemedEllipsis
      size={iconButtonChromeGlyphSize("large")}
      uniProps={extraMutedIconColorMapping}
    />
  );
}

/**
 * The compact header buttons draw at 32pt, under the 44pt touch minimum, and sit flush against
 * each other — so the slop can only grow vertically. Widening it would put two buttons' slop over
 * the same pixels, which is a worse miss than a small target.
 */
const COMPACT_HEADER_BUTTON_HIT_SLOP = { top: 8, bottom: 8 } as const;

/**
 * Actions that belong to the workspace itself rather than to a tab. Both header menus render them,
 * from the same callbacks, so the two surfaces can't drift.
 */
export interface WorkspaceHeaderWorkspaceActions {
  currentBranchName: string | null;
  copyPathDisabled: boolean;
  onCopyWorkspacePath: () => void;
  onCopyBranchName: () => void;
}

function WorkspaceHeaderWorkspaceActionItems({
  currentBranchName,
  copyPathDisabled,
  onCopyWorkspacePath,
  onCopyBranchName,
}: WorkspaceHeaderWorkspaceActions) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        testID="workspace-header-copy-path"
        leading={MENU_COPY_ICON}
        disabled={copyPathDisabled}
        onSelect={onCopyWorkspacePath}
      >
        {t("workspace.header.actions.copyPath")}
      </DropdownMenuItem>
      {currentBranchName ? (
        <DropdownMenuItem
          testID="workspace-header-copy-branch-name"
          leading={MENU_COPY_ICON}
          onSelect={onCopyBranchName}
        >
          {t("workspace.header.actions.copyBranchName")}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function workspaceHeaderMenuButtonStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return iconButtonChromeStyle({ size: "large", state: { hovered, pressed, open } });
}

/**
 * Wide layouts: workspace actions only.
 */
export function WorkspaceHeaderMenuDesktop(props: WorkspaceHeaderWorkspaceActions) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID="workspace-header-menu-trigger"
        style={workspaceHeaderMenuButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.header.actions.workspaceActions")}
      >
        <WorkspaceHeaderMenuTriggerIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={220} testID="workspace-header-menu">
        <WorkspaceHeaderWorkspaceActionItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface WorkspaceHeaderMenuMobileProps extends WorkspaceHeaderWorkspaceActions {
  /**
   * Render the sheet with no trigger of its own: something else opens it through `open` /
   * `onOpenChange` (the phone's title pill). Only valid where the menu presents as a sheet, which
   * needs no anchor.
   */
  hideTrigger?: boolean;
  /** Rendered first in the sheet: the workspace context card and the Tabs group. */
  leadingContent?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Compact layouts: the workspace actions, after the optional leading content. */
export function WorkspaceHeaderMenuMobile({
  hideTrigger = false,
  leadingContent,
  open,
  onOpenChange,
  ...workspaceActions
}: WorkspaceHeaderMenuMobileProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      {hideTrigger ? null : (
        <DropdownMenuTrigger
          testID="workspace-header-menu-trigger"
          style={workspaceHeaderMenuButtonStyle}
          hitSlop={COMPACT_HEADER_BUTTON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.header.actions.workspaceActions")}
        >
          <WorkspaceHeaderMenuTriggerIcon />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="start"
        width={220}
        testID="workspace-header-menu"
        sheetTitle={leadingContent ? undefined : t("workspace.header.actions.workspaceActions")}
      >
        {leadingContent ? (
          <>
            {leadingContent}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <WorkspaceHeaderWorkspaceActionItems {...workspaceActions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
