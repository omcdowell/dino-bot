/**
 * Model providers from the app after setup: the bots plugin's provider.* RPCs
 * (plugins/bots/shared/provider-rpc.ts), host side DinoBot's installer (lib/provider-install.mjs).
 * The computer does the install (`pi install` into DinoBot's pi dir, no sudo) and keeps the
 * sign-in; this app only asks and shows progress.
 *
 * Feature gate: a daemon from before these RPCs answers "Unknown RPC method: provider.…"; the app
 * then falls back to copying the `dinobot provider add` command (provider-link.tsx).
 */
import { ONBOARDING_ROUTES } from "./onboarding-model";

export const PROVIDER_RPC = {
  pluginId: "bots",
  list: "provider.list",
  install: "provider.install",
  installStatus: "provider.install-status",
  remove: "provider.remove",
} as const;

export interface ProviderRow {
  provider: string;
  plugin: string | null;
  ready: boolean;
  optionId: string | null;
  label: string;
}

export interface ProviderListAnswer {
  available: boolean;
  packages: Array<{ source: string; bundled: boolean }>;
  providers: ProviderRow[];
  error: string | null;
}

export interface InstallStatus {
  jobId: string;
  source: string;
  name: string | null;
  state: "running" | "done" | "error" | string;
  step: "installing" | "checking" | "models" | "done" | string;
  error: string | null;
  providers: ProviderRow[];
}

export interface InstallInput {
  source: string;
  token: string | null;
  name: string | null;
}

/** The daemon (or its bots plugin) predates provider.*: use the copy-the-command fallback. */
export function isUnsupportedRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Unknown RPC method: provider\./i.test(message);
}

/**
 * What provider.install needs from an invite link (`<scheme>://provider/add?source=…&token=…&name=…`).
 * The token goes to the paired computer only (over the daemon connection) and is not kept here.
 */
export function installInputFromLink(link: string, scheme: string): InstallInput | null {
  const raw = link.trim();
  const prefix = `${scheme.toLowerCase()}://`;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const q = rest.indexOf("?");
  if (q < 0 || rest.slice(0, q).replace(/\/+$/, "") !== "provider/add") return null;
  const params = new URLSearchParams(rest.slice(q + 1));
  const source = params.get("source")?.trim();
  if (!source) return null;
  return {
    source,
    token: params.get("token")?.trim() || null,
    name: params.get("name")?.trim() || null,
  };
}

export const INSTALL_STEP_COPY: Record<string, string> = {
  installing: "Downloading and installing…",
  checking: "Checking what it adds…",
  models: "Updating the model list…",
  done: "Installed.",
};

export function installStepCopy(step: string): string {
  return INSTALL_STEP_COPY[step] ?? "Working…";
}

/** A sign-in started from Settings (not onboarding): setup-signin returns where it came from. */
export function signInRoute(serverId: string, optionId?: string | null): string {
  const q = new URLSearchParams({ serverId, from: "settings" });
  if (optionId) q.set("option", optionId);
  return `${ONBOARDING_ROUTES.signin}?${q.toString()}`;
}

/** The provider-link screen for a pasted link, on one host. */
export function providerLinkRoute(link: string, serverId?: string | null): string {
  const q = new URLSearchParams({ link: link.trim() });
  if (serverId) q.set("serverId", serverId);
  return `/provider-link?${q.toString()}`;
}

export type AfterInstall =
  | { kind: "ready"; labels: string[] }
  | { kind: "signin"; optionId: string; label: string }
  | { kind: "no-signin"; providers: string[] };

/**
 * Where a finished install goes: straight to the sign-in the new provider needs (a plugin that
 * replaces "anthropic" → the Claude login), else "ready". A package that registers a provider with no
 * sign-in in the host's list (or none at all) is "no-signin": usable as it is, or set up on the
 * computer.
 */
export function afterInstall(status: InstallStatus): AfterInstall {
  const waiting = status.providers.filter((p) => !p.ready);
  const next = waiting.find((p) => p.optionId);
  if (next?.optionId) return { kind: "signin", optionId: next.optionId, label: next.label };
  if (waiting.length) return { kind: "no-signin", providers: waiting.map((p) => p.provider) };
  return { kind: "ready", labels: status.providers.map((p) => p.label) };
}

/** "git:https://github.com/o/r@v1" → "github.com/o/r@v1"; "npm:x@1" → "x@1". */
export function packageLabel(source: string): string {
  return source.replace(/^git:(https:\/\/)?/, "").replace(/^npm:/, "");
}
