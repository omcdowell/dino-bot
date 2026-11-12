/**
 * compact_v2 (CV1, wave 2): a lossless-for-the-app wire encoding of the directory, status and
 * timeline messages, applied per socket by the daemon at serialization time and undone by the
 * client before validation. Nothing above the transport sees the compact shape.
 *
 *   A1  status.features -> `fh` (hash) once the client holds the map; `permissions` dropped
 *   A2  repeated availableModes/features of agent rows -> per-message table `$r` (nothing deferred)
 *   A3  repeated project placements -> `$r`; cwd/projectRootPath/checkout.cwd equal to their
 *       reference omitted
 *   A4  timeline rows: trivial sourceSeqRanges, seqEnd==seqStart, empty collapsed, per-row provider,
 *       metadata.kind==name, shell detail.type omitted; paseoCompact -> 1; agent copy dropped on
 *       non-tail pages
 *   A7  null/false/[]/{} defaults omitted (explicit key lists); ISO timestamps -> epoch ms
 *
 * Every rule is "omit when equal to X, restore X when absent", with X fixed per key, so
 * decode(encode(m)) == m except for the documented unread fields (paseoCompact contents,
 * status.permissions, agent copy on history pages). Encoder never mutates its input.
 */

type Obj = Record<string, unknown>;

/** Marker the daemon puts on a compact socket's status; arms the client decoder. */
export const COMPACT_V2_STATUS_MARK = "cv2";
/** Hello capability key carrying the feature-map hash the client already holds. */
export const COMPACT_V2_FEATURES_HASH_CAP = "compact_v2_fh";

const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function isoToEpoch(value: unknown): unknown {
  if (typeof value !== "string" || !ISO_MS.test(value)) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return value;
  return ms;
}

function epochToIso(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : value;
}

interface DefaultsSpec {
  nulls?: readonly string[];
  falses?: readonly string[];
  emptyArrays?: readonly string[];
  emptyObjects?: readonly string[];
  times?: readonly string[];
}

const AGENT: DefaultsSpec = {
  nulls: [
    "model",
    "thinkingOptionId",
    "effectiveThinkingOptionId",
    "lastUserMessageAt",
    "currentModeId",
    "title",
    "attentionReason",
    "attentionTimestamp",
    "archivedAt",
  ],
  // activeTurn, persistence, features, providerUnavailable are often absent, and absent differs
  // from null/[] for the app (activeTurn absent + running = open turn): left as they are.
  falses: ["requiresAttention"],
  emptyArrays: ["pendingPermissions", "availableModes"],
  emptyObjects: ["labels"],
  times: ["createdAt", "updatedAt", "lastUserMessageAt", "attentionTimestamp", "archivedAt"],
};

const WORKSPACE: DefaultsSpec = {
  nulls: [
    "projectCustomName",
    "projectCustomIconRevision",
    "title",
    "pinnedAt",
    "archivingAt",
    "statusEnteredAt",
    "activityAt",
    "diffStat",
  ],
  falses: ["background"],
  emptyArrays: ["scripts"],
  times: ["pinnedAt", "archivingAt", "statusEnteredAt", "activityAt"],
};

const PROJECT: DefaultsSpec = { nulls: ["workspaceName"] };
// worktreeRoot is only ever null on the non-git variant (git variants: string or absent); it is
// restored only when isGit is false (see decodeCheckout).
const CHECKOUT: DefaultsSpec = {
  nulls: ["currentBranch", "remoteUrl", "mainRepoRoot"],
  falses: ["isGit", "isPaseoOwnedWorktree"],
};

const TIMELINE_PAGE: DefaultsSpec = {
  nulls: ["error", "startCursor", "endCursor"],
  falses: ["reset", "staleCursor", "gap", "hasOlder", "hasNewer"],
};

const PATCH_TIMES = ["createdAt", "updatedAt", "lastUserMessageAt", "attentionTimestamp", "archivedAt"];

function omitDefaults(source: Obj, spec: DefaultsSpec): Obj {
  const out: Obj = { ...source };
  for (const key of spec.nulls ?? []) if (out[key] === null) delete out[key];
  for (const key of spec.falses ?? []) if (out[key] === false) delete out[key];
  for (const key of spec.emptyArrays ?? [])
    if (Array.isArray(out[key]) && (out[key] as unknown[]).length === 0) delete out[key];
  for (const key of spec.emptyObjects ?? [])
    if (isObj(out[key]) && Object.keys(out[key] as Obj).length === 0) delete out[key];
  for (const key of spec.times ?? []) if (key in out) out[key] = isoToEpoch(out[key]);
  return out;
}

function restoreDefaults(target: Obj, spec: DefaultsSpec): void {
  for (const key of spec.times ?? []) if (key in target) target[key] = epochToIso(target[key]);
  for (const key of spec.nulls ?? []) if (!(key in target)) target[key] = null;
  for (const key of spec.falses ?? []) if (!(key in target)) target[key] = false;
  for (const key of spec.emptyArrays ?? []) if (!(key in target)) target[key] = [];
  for (const key of spec.emptyObjects ?? []) if (!(key in target)) target[key] = {};
}

// ---- rows ---------------------------------------------------------------------------------------

function encodeProject(project: unknown): unknown {
  if (!isObj(project)) return project;
  const out = omitDefaults(project, PROJECT);
  if (isObj(project.checkout)) {
    const checkout = omitDefaults(project.checkout, CHECKOUT);
    if (checkout.worktreeRoot === null && project.checkout.isGit === false) delete checkout.worktreeRoot;
    out.checkout = checkout;
  }
  return out;
}

function decodeProject(project: unknown): void {
  if (!isObj(project)) return;
  restoreDefaults(project, PROJECT);
  const checkout = project.checkout;
  if (!isObj(checkout)) return;
  restoreDefaults(checkout, CHECKOUT);
  if (checkout.isGit === false && !("worktreeRoot" in checkout)) checkout.worktreeRoot = null;
}

function encodeAgent(agent: unknown, project: unknown): unknown {
  if (!isObj(agent)) return agent;
  const out = omitDefaults(agent, AGENT);
  if (isObj(agent.activeTurn) && "startedAt" in agent.activeTurn)
    out.activeTurn = { ...agent.activeTurn, startedAt: isoToEpoch(agent.activeTurn.startedAt) };
  const projectCwd = isObj(project) && isObj(project.checkout) ? project.checkout.cwd : undefined;
  if (typeof agent.cwd === "string" && agent.cwd === projectCwd) delete out.cwd;
  return out;
}

function decodeAgent(agent: unknown, project: unknown): void {
  if (!isObj(agent)) return;
  restoreDefaults(agent, AGENT);
  if (isObj(agent.activeTurn) && "startedAt" in agent.activeTurn)
    agent.activeTurn.startedAt = epochToIso(agent.activeTurn.startedAt);
  if (!("cwd" in agent) && isObj(project) && isObj(project.checkout)) agent.cwd = project.checkout.cwd;
}

function encodeWorkspace(workspace: unknown): unknown {
  if (!isObj(workspace)) return workspace;
  const out = omitDefaults(workspace, WORKSPACE);
  const dir = workspace.workspaceDirectory;
  if (typeof dir === "string" && workspace.projectRootPath === dir) delete out.projectRootPath;
  if (isObj(workspace.project)) {
    const project = encodeProject(workspace.project) as Obj;
    if (typeof dir === "string" && isObj(project.checkout) && project.checkout.cwd === dir) {
      const { cwd: _cwd, ...rest } = project.checkout;
      project.checkout = rest;
    }
    out.project = project;
  }
  return out;
}

function decodeWorkspace(workspace: unknown): void {
  if (!isObj(workspace)) return;
  restoreDefaults(workspace, WORKSPACE);
  const dir = workspace.workspaceDirectory;
  if (!("projectRootPath" in workspace) && typeof dir === "string") workspace.projectRootPath = dir;
  if (isObj(workspace.project)) {
    decodeProject(workspace.project);
    const checkout = workspace.project.checkout;
    if (isObj(checkout) && !("cwd" in checkout) && typeof dir === "string") checkout.cwd = dir;
  }
}

function encodeItem(item: unknown): unknown {
  if (!isObj(item)) return item;
  let out: Obj | null = null;
  const edit = () => (out ??= { ...item });
  if (isObj(item.metadata)) {
    const metadata: Obj = { ...item.metadata };
    if (item.type === "tool_call" && typeof item.name === "string") {
      if (!("kind" in metadata)) metadata.kind = 0;
      else if (metadata.kind === item.name) delete metadata.kind;
    }
    if (isObj(metadata.paseoCompact)) metadata.paseoCompact = 1;
    edit().metadata = metadata;
  }
  if (
    item.type === "tool_call" &&
    item.name === "execute" &&
    isObj(item.detail) &&
    item.detail.type === "shell"
  ) {
    const { type: _type, ...detail } = item.detail;
    edit().detail = detail;
  }
  return out ?? item;
}

function decodeItem(item: unknown): void {
  if (!isObj(item)) return;
  const metadata = item.metadata;
  if (isObj(metadata)) {
    if (item.type === "tool_call" && typeof item.name === "string") {
      if (!("kind" in metadata)) metadata.kind = item.name;
      else if (metadata.kind === 0) delete metadata.kind;
    }
    if (metadata.paseoCompact === 1) metadata.paseoCompact = {};
  }
  if (item.type === "tool_call" && item.name === "execute" && isObj(item.detail) && !("type" in item.detail))
    item.detail = { type: "shell", ...item.detail };
}

function encodeTimelineRow(row: unknown, provider: unknown): unknown {
  if (!isObj(row)) return row;
  const out: Obj = { ...row, item: encodeItem(row.item) };
  if (provider !== undefined && row.provider === provider) delete out.provider;
  const ranges = row.sourceSeqRanges;
  if (
    Array.isArray(ranges) &&
    ranges.length === 1 &&
    isObj(ranges[0]) &&
    Object.keys(ranges[0]).length === 2 &&
    ranges[0].startSeq === row.seqStart &&
    ranges[0].endSeq === row.seqEnd
  )
    delete out.sourceSeqRanges;
  if ("seqEnd" in row && row.seqEnd === row.seqStart) delete out.seqEnd;
  if (Array.isArray(row.collapsed) && row.collapsed.length === 0) delete out.collapsed;
  if ("timestamp" in row) out.timestamp = isoToEpoch(row.timestamp);
  return out;
}

function decodeTimelineRow(row: unknown, provider: unknown): void {
  if (!isObj(row)) return;
  decodeItem(row.item);
  if (!("provider" in row) && provider !== undefined) row.provider = provider;
  if (!("seqEnd" in row) && "seqStart" in row) row.seqEnd = row.seqStart;
  if (!("sourceSeqRanges" in row) && "seqStart" in row)
    row.sourceSeqRanges = [{ startSeq: row.seqStart, endSeq: row.seqEnd }];
  if (!("collapsed" in row)) row.collapsed = [];
  if ("timestamp" in row) row.timestamp = epochToIso(row.timestamp);
}

// ---- per-message tables (A2, A3) ----------------------------------------------------------------

/** Values seen at least twice in one message go to `$r`; rows carry the index. */
class RefTable {
  private readonly counts = new Map<string, number>();
  private readonly index = new Map<string, number>();
  readonly values: unknown[] = [];
  count(value: unknown): void {
    if (value === undefined) return;
    const key = JSON.stringify(value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  ref(value: unknown): unknown {
    if (value === undefined) return value;
    const key = JSON.stringify(value);
    if ((this.counts.get(key) ?? 0) < 2) return value;
    let at = this.index.get(key);
    if (at === undefined) {
      at = this.values.length;
      this.values.push(value);
      this.index.set(key, at);
    }
    return at;
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function deref(value: unknown, table: unknown): unknown {
  if (typeof value !== "number" || !Array.isArray(table)) return value;
  return clone(table[value]);
}

// ---- messages -----------------------------------------------------------------------------------

export interface CompactV2SocketState {
  /** The feature-map hash this socket's client holds (hello compact_v2_fh, or sent here). */
  knownFeaturesHash: string | null;
}

export interface CompactV2EncodeContext {
  state: CompactV2SocketState;
  hashFeatures: (features: unknown) => string;
}

function encodeAgentEntries(entries: unknown[]): { entries: unknown[]; refs: unknown[] } {
  const table = new RefTable();
  const staged = entries.map((entry) => {
    if (!isObj(entry)) return { entry, project: undefined, agent: undefined };
    const project = encodeProject(entry.project);
    const agent = encodeAgent(entry.agent, entry.project);
    table.count(project);
    if (isObj(agent)) {
      table.count(agent.availableModes);
      table.count(agent.features);
    }
    return { entry, project, agent };
  });
  const out = staged.map(({ entry, project, agent }) => {
    if (!isObj(entry)) return entry;
    const next: Obj = { ...entry };
    if (isObj(agent)) {
      const row: Obj = { ...agent };
      if ("availableModes" in row) row.availableModes = table.ref(row.availableModes);
      if ("features" in row) row.features = table.ref(row.features);
      next.agent = row;
    } else next.agent = agent;
    if ("project" in entry) next.project = table.ref(project);
    return next;
  });
  return { entries: out, refs: table.values };
}

function decodeAgentEntries(entries: unknown, table: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!isObj(entry)) continue;
    if ("project" in entry) {
      entry.project = deref(entry.project, table);
      decodeProject(entry.project);
    }
    const agent = entry.agent;
    if (isObj(agent)) {
      if ("availableModes" in agent) agent.availableModes = deref(agent.availableModes, table);
      if ("features" in agent) agent.features = deref(agent.features, table);
    }
    decodeAgent(agent, entry.project);
  }
}

function encodeWorkspaceEntries(entries: unknown[]): { entries: unknown[]; refs: unknown[] } {
  const table = new RefTable();
  const staged = entries.map((entry) => encodeWorkspace(entry));
  for (const entry of staged) if (isObj(entry)) table.count(entry.project);
  const out = staged.map((entry) =>
    isObj(entry) && "project" in entry ? { ...entry, project: table.ref(entry.project) } : entry,
  );
  return { entries: out, refs: table.values };
}

function decodeWorkspaceEntries(entries: unknown, table: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!isObj(entry)) continue;
    if ("project" in entry) entry.project = deref(entry.project, table);
    decodeWorkspace(entry);
  }
}

function mostCommon(values: unknown[]): unknown {
  const counts = new Map<unknown, number>();
  let best: unknown;
  let bestCount = 0;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function encodeSessionPayload(type: string, payload: Obj, ctx: CompactV2EncodeContext): Obj | null {
  switch (type) {
    case "status": {
      if (payload.status !== "server_info") return null;
      const { permissions: _permissions, features, ...rest } = payload;
      const out: Obj = { ...rest, [COMPACT_V2_STATUS_MARK]: 1 };
      if (features !== undefined) {
        const hash = ctx.hashFeatures(features);
        if (ctx.state.knownFeaturesHash !== hash) {
          out.features = features;
          ctx.state.knownFeaturesHash = hash;
        }
        out.fh = hash;
      }
      return out;
    }
    case "fetch_agents_response": {
      if (!Array.isArray(payload.entries)) return null;
      const { entries, refs } = encodeAgentEntries(payload.entries);
      return { ...payload, entries, ...(refs.length > 0 ? { $r: refs } : {}) };
    }
    case "fetch_workspaces_response": {
      if (!Array.isArray(payload.entries)) return null;
      const { entries, refs } = encodeWorkspaceEntries(payload.entries);
      return { ...payload, entries, ...(refs.length > 0 ? { $r: refs } : {}) };
    }
    case "fetch_agent_response":
    case "agent_update": {
      if (!isObj(payload.agent)) return null;
      const out: Obj = { ...payload, agent: encodeAgent(payload.agent, payload.project) };
      if ("project" in payload) out.project = encodeProject(payload.project);
      return out;
    }
    case "workspace_update": {
      if (!isObj(payload.workspace)) return null;
      return { ...payload, workspace: encodeWorkspace(payload.workspace) };
    }
    case "agent_patch": {
      if (!isObj(payload.set)) return null;
      const set: Obj = { ...payload.set };
      for (const key of PATCH_TIMES) if (key in set) set[key] = isoToEpoch(set[key]);
      if (isObj(set.activeTurn) && "startedAt" in set.activeTurn)
        set.activeTurn = { ...set.activeTurn, startedAt: isoToEpoch(set.activeTurn.startedAt) };
      return { ...payload, set };
    }
    case "fetch_agent_timeline_response": {
      if (!Array.isArray(payload.entries)) return null;
      const provider = mostCommon(payload.entries.map((row) => (isObj(row) ? row.provider : undefined)));
      const out = omitDefaults(payload, TIMELINE_PAGE);
      out.entries = payload.entries.map((row) => encodeTimelineRow(row, provider));
      if (provider !== undefined) out.provider = provider;
      if (payload.direction === "tail") {
        if (isObj(payload.agent)) out.agent = encodeAgent(payload.agent, undefined);
      } else delete out.agent;
      return out;
    }
    case "agent_attention_required": {
      if (!("timestamp" in payload)) return null;
      return { ...payload, timestamp: isoToEpoch(payload.timestamp) };
    }
    case "agent_stream": {
      const out: Obj = { ...payload };
      if ("timestamp" in payload) out.timestamp = isoToEpoch(payload.timestamp);
      const event = payload.event;
      if (isObj(event) && event.type === "timeline" && isObj(event.item))
        out.event = { ...event, item: encodeItem(event.item) };
      return out;
    }
    default:
      return null;
  }
}

function decodeSessionPayload(type: string, payload: Obj): void {
  switch (type) {
    case "fetch_agents_response":
      decodeAgentEntries(payload.entries, payload.$r);
      delete payload.$r;
      return;
    case "fetch_workspaces_response":
      decodeWorkspaceEntries(payload.entries, payload.$r);
      delete payload.$r;
      return;
    case "fetch_agent_response":
    case "agent_update":
      if (!isObj(payload.agent)) return;
      if ("project" in payload) decodeProject(payload.project);
      decodeAgent(payload.agent, payload.project);
      return;
    case "workspace_update":
      decodeWorkspace(payload.workspace);
      return;
    case "agent_patch": {
      const set = payload.set;
      if (!isObj(set)) return;
      for (const key of PATCH_TIMES) if (key in set) set[key] = epochToIso(set[key]);
      if (isObj(set.activeTurn) && "startedAt" in set.activeTurn)
        set.activeTurn.startedAt = epochToIso(set.activeTurn.startedAt);
      return;
    }
    case "fetch_agent_timeline_response": {
      if (!Array.isArray(payload.entries)) return;
      restoreDefaults(payload, TIMELINE_PAGE);
      const provider = payload.provider;
      delete payload.provider;
      for (const row of payload.entries) decodeTimelineRow(row, provider);
      if (!("agent" in payload)) payload.agent = null;
      else decodeAgent(payload.agent, undefined);
      return;
    }
    case "agent_attention_required":
      if ("timestamp" in payload) payload.timestamp = epochToIso(payload.timestamp);
      return;
    case "agent_stream": {
      if ("timestamp" in payload) payload.timestamp = epochToIso(payload.timestamp);
      const event = payload.event;
      if (isObj(event) && event.type === "timeline") decodeItem(event.item);
      return;
    }
  }
}

/**
 * Daemon side: the compact form of one outbound WS message for a compact_v2 socket, or the same
 * object when nothing applies. Never mutates `message`.
 */
export function encodeCompactV2<T>(message: T, ctx: CompactV2EncodeContext): T {
  if (!isObj(message) || message.type !== "session" || !isObj(message.message)) return message;
  const inner = message.message;
  if (typeof inner.type !== "string" || !isObj(inner.payload)) return message;
  const payload = encodeSessionPayload(inner.type, inner.payload, ctx);
  if (!payload) return message;
  return { ...message, message: { ...inner, payload } } as T;
}

export interface CompactV2FeatureCache {
  get(): { hash: string; features: Record<string, unknown> } | null;
  set(value: { hash: string; features: Record<string, unknown> }): void;
}

/**
 * Client side: undoes encodeCompactV2 in place on a parsed WS message (one batch item at a time).
 * Inert until the socket's status carries the cv2 mark (`armed`); call `reset()` per new socket.
 */
export class CompactV2Decoder {
  private armedValue = false;
  constructor(private readonly features: CompactV2FeatureCache) {}

  get armed(): boolean {
    return this.armedValue;
  }

  reset(): void {
    this.armedValue = false;
  }

  /** The hash to present in hello (compact_v2_fh), if a feature map is cached. */
  cachedFeaturesHash(): string | null {
    return this.features.get()?.hash ?? null;
  }

  decode(message: unknown): unknown {
    if (!isObj(message) || message.type !== "session" || !isObj(message.message)) return message;
    const inner = message.message;
    if (typeof inner.type !== "string" || !isObj(inner.payload)) return message;
    const payload = inner.payload;
    if (inner.type === "status" && payload.status === "server_info") {
      this.armedValue = payload[COMPACT_V2_STATUS_MARK] === 1;
      if (!this.armedValue) return message;
      delete payload[COMPACT_V2_STATUS_MARK];
      const hash = payload.fh;
      delete payload.fh;
      if (typeof hash === "string") {
        if (isObj(payload.features)) this.features.set({ hash, features: payload.features });
        else {
          const cached = this.features.get();
          if (cached && cached.hash === hash) payload.features = clone(cached.features);
        }
      }
      return message;
    }
    if (!this.armedValue) return message;
    decodeSessionPayload(inner.type, payload);
    return message;
  }
}

export function createMemoryFeatureCache(): CompactV2FeatureCache {
  let value: { hash: string; features: Record<string, unknown> } | null = null;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}
