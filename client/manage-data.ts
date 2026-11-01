/**
 * Bot management on the client (build 31): the home state query (pins, archive), its actions, the
 * app extras this needs (image picker, haptics) and the "⋯" menu requests.
 *
 * Paseo builds from 31 expose `pickImage` and `haptic` on `@getpaseo/plugin/client/react-native`
 * and read the home screen's `mobileHomeMenu`. Older apps have neither: avatars cannot be changed
 * there and the home draws its own small "Manage" links instead of the menu entries.
 * No react-native import here, so the helpers run under `tsx --test`.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ComponentType } from "react";
import type { HomeState } from "../shared/manage";
import { homeArchiveRpc, homePinRpc, homeStateRpc } from "../shared/manage-rpc";
import { BOTS_QUERY_KEY } from "./bot-data";
import { ROOMS_LIST_KEY } from "./group-data";
import { hostSvgXml, type SvgXmlComponent } from "./host-svg";

export const HOME_STATE_KEY = ["bots", "home-state"] as const;

export type HapticKind = "selection" | "light" | "medium" | "success" | "warning";
export interface HostExtras {
  pickImage: ((options?: { square?: boolean; maxSize?: number }) => Promise<{ dataUri: string; width: number; height: number } | null>) | null;
  haptic: (kind?: HapticKind) => void;
  /** The app draws `mobileHomeMenu` entries (same build as pickImage). */
  homeMenu: boolean;
  /** The app's model picker field (`@getpaseo/plugin/client/ui`, Scoped / All builds); null on older apps. */
  ModelPickerField: ComponentType<ModelPickerFieldProps> | null;
  /** react-native-svg's SvgXml from the app (client/host-svg.ts); null on apps without it (no avatar designer). */
  SvgXml: SvgXmlComponent | null;
}

/** What paseo-bots passes to the app's ModelPickerField (`@getpaseo/plugin/client/ui`). */
export interface ModelPickerFieldProps {
  serverId: string;
  provider: string;
  modelId: string;
  thinkingId: string | null;
  onChange(value: { modelId: string; thinkingId: string | null }): void;
  label?: string;
  thinkingLabel?: string;
  disabled?: boolean;
  testID?: string;
}

/** What the app offers on its react-native plugin module (feature-detected). */
export function hostExtras(module: unknown, uiModule?: unknown): HostExtras {
  const m = (module && typeof module === "object" ? module : {}) as Record<string, unknown>;
  const ui = (uiModule && typeof uiModule === "object" ? uiModule : {}) as Record<string, unknown>;
  const pickImage = typeof m.pickImage === "function" ? (m.pickImage as HostExtras["pickImage"]) : null;
  const haptic = typeof m.haptic === "function" ? (m.haptic as HostExtras["haptic"]) : () => {};
  const picker = ui.ModelPickerField;
  const ModelPickerField =
    typeof picker === "function" || (picker !== null && typeof picker === "object")
      ? (picker as ComponentType<ModelPickerFieldProps>)
      : null;
  return { pickImage, haptic, homeMenu: pickImage !== null, ModelPickerField, SvgXml: hostSvgXml(module) };
}

/** Pins and archive state, kept on the device so a cold start draws the last known pinned row. */
export function useHomeState() {
  const getState = useRpc(homeStateRpc);
  const query = useQuery({
    queryKey: HOME_STATE_KEY,
    queryFn: () => getState({}),
    staleTime: 15_000,
    refetchInterval: 60_000,
    meta: { persist: true },
  });
  return { state: (query.data as HomeState | undefined) ?? null, refetch: query.refetch };
}

export function useHomeActions() {
  const queryClient = useQueryClient();
  const pinRpc = useRpc(homePinRpc);
  const archiveRpc = useRpc(homeArchiveRpc);
  const store = (state: HomeState) => {
    queryClient.setQueryData(HOME_STATE_KEY, state);
    return state;
  };
  return {
    pin: (key: string, pinned: boolean) => pinRpc({ key, pinned }).then(store),
    archive: (key: string, archived: boolean) => archiveRpc({ key, archived }).then(store),
    /** After a create or edit: bots, groups and the state again. */
    refreshAll: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ROOMS_LIST_KEY }),
        queryClient.invalidateQueries({ queryKey: HOME_STATE_KEY }),
      ]),
  };
}

// ---------- "⋯" menu -> home ----------

export type ManageRequest = "new-bot" | "new-group" | "archived";
const listeners = new Set<(request: ManageRequest) => void>();

/** Menu entries call this; the mounted home opens the sheet. */
export function requestManage(request: ManageRequest): void {
  for (const listener of listeners) listener(request);
}

export function useManageRequests(onRequest: (request: ManageRequest) => void): void {
  useEffect(() => {
    listeners.add(onRequest);
    return () => {
      listeners.delete(onRequest);
    };
  }, [onRequest]);
}

/** The phone home's "⋯" menu entries (apps from build 31 draw them). */
export const HOME_MENU = {
  title: "Bots",
  items: [
    { id: "new-bot", title: "New bot", icon: "Bot", onSelect: () => requestManage("new-bot") },
    { id: "new-group", title: "New group chat", icon: "Users", onSelect: () => requestManage("new-group") },
    { id: "archived", title: "Archived", icon: "Archive", onSelect: () => requestManage("archived") },
  ],
};
