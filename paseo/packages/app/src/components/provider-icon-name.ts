import { BUILTIN_PROVIDER_ICON_NAMES } from "@getpaseo/protocol/provider-icon-names";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "svg"; svg: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDER_ICON_NAMES);
export function resolveProviderIconName(provider: string, iconSvg?: string): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider)) {
    return { kind: "builtin", id: provider };
  }
  if (iconSvg) {
    return { kind: "svg", svg: iconSvg };
  }
  return { kind: "bot" };
}
