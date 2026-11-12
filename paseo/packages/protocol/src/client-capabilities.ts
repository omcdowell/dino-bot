export const CLIENT_CAPS = {
  helloRejection: "hello_rejection",
  // Capable clients accept a session.token frame after a password hello and may present it
  // (hello auth kind sessionToken) instead of the password on later hellos.
  sessionTokens: "session_tokens",
  // COMPAT(ownedSubscriptions): added in v0.8.0, remove legacy ownership after 2027-03-09.
  ownedSubscriptions: "owned_subscriptions",
  // Clients outside the Paseo app version series can explicitly accept provider IDs.
  // COMPAT(explicitEventSubscriptions): added in v0.8.0, remove legacy broadcasts after 2027-03-08.
  explicitEventSubscriptions: "explicit_event_subscriptions",
  allProviders: "all_providers",
  // COMPAT(selectiveAgentTimeline): added in v0.1.106. Capable clients receive
  // agent streams only for their explicit viewed set. Remove after 2027-01-12
  // once the supported client floor is >= v0.1.106.
  selectiveAgentTimeline: "selective_agent_timeline",
  reasoningMergeEnum: "reasoning_merge_enum",
  // COMPAT(customModeIcons): added in v0.1.84. Old clients pin AgentModeIcon to
  // a closed enum and crash rendering unknown values; daemon downgrades icons
  // outside the legacy set to "ShieldCheck" when this cap is absent. Drop the
  // gate when floor >= v0.1.84.
  customModeIcons: "custom_mode_icons",
  // COMPAT(terminalReflowableSnapshot): added in v0.1.88. The daemon attaches
  // per-row soft-wrap flags (gridWrapped/scrollbackWrapped) to terminal snapshots
  // only when the client advertises this, so restored content can reflow on resize.
  // Old clients use a strict TerminalState schema and would reject the extra fields.
  // Drop the gate (always send the flags) when floor >= v0.1.88.
  terminalReflowableSnapshot: "terminal_reflowable_snapshot",
  // COMPAT(providerSubagents): added in v0.1.107. The daemon emits provider-owned
  // child descriptors and timelines only to clients that understand the new messages.
  providerSubagents: "provider_subagents",
  // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gates after 2027-03-14; retain wire capability.
  projectedSubagentTimeline: "projected_subagent_timeline",
  // COMPAT(projectUpdates): added in v0.1.109, remove gate after 2027-01-15.
  projectUpdates: "project_updates",
  // COMPAT(compactProviderSnapshots): added in v0.2.X. Capable clients receive
  // provider catalogs with shared thinking sets and may revalidate by content hash.
  // Remove the legacy snapshot encoding after 2027-02-04.
  compactProviderSnapshots: "compact_provider_snapshots",
  providerSnapshotReferences: "provider_snapshot_references",
  // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove legacy
  // reconstructed timeline replay after 2027-02-21 once the client floor supports invalidation.
  timelineReplacementInvalidation: "timeline_replacement_invalidation",
  // COMPAT(timelineNotifications): added in v0.7.2. The daemon omits notification
  // timeline items for older clients whose strict timeline union rejects them.
  // Remove after 2027-03-03 once the supported client floor is >= v0.7.2.
  timelineNotifications: "timeline_notifications",
  // COMPAT(pluginTimelineItems): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  pluginTimelineItems: "plugin_timeline_items",
  // COMPAT(workspaceSetupBlocked): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  workspaceSetupBlocked: "workspace_setup_blocked",
  browserHost: "browser_host",
  // COMPAT(messageReceivedAck): added in v0.11.2. The daemon acknowledges a tracked send as
  // soon as it has recorded the message, before the agent takes it, only for clients that
  // advertise this. Old clients never see send_agent_message_received.
  messageReceivedAck: "message_received_ack",
  // COMPAT(compressedFrames): added in v0.11.2. Capable clients accept JSON frames as binary
  // [0x20, raw DEFLATE] frames (binary-frames/compressed-json); old clients get plain text.
  compressedFrames: "compressed_frames",
  // COMPAT(checkedFrames): added in v0.11.3. Capable clients get every JSON frame as a checked
  // [0x21, generation, seq, crc32, raw DEFLATE] frame and answer a broken one with a reset
  // (binary-frames/compressed-json) instead of reconnecting. Others keep 0x20 frames.
  checkedFrames: "checked_frames",
  // COMPAT(zstdFrames): added in v0.11.3. With checked_frames: every JSON frame is a checked zstd
  // frame [0x24, generation, seq, crc32, zstd stream chunk], one zstd stream per socket flushed
  // per message (binary-frames/compressed-json). Daemons without node:zlib zstd keep 0x21.
  zstdFrames: "zstd_frames",
  // COMPAT(agentPatches): added in v0.11.3. Capable clients get agent_patch (changed fields and a
  // revision) instead of repeated full agent_update snapshots on owned agent subscriptions, and no
  // update at all when nothing changed. Others keep full snapshots.
  agentPatches: "agent_patches",
  // COMPAT(prioritySync): added in v0.11.3 (PS2). Capable clients get JSON messages through
  // per-socket priority lanes (open chat and notifications first, bulk last, low-watermark sending)
  // and may receive several messages in one {"type":"batch","m":[...]} frame. Old clients keep one
  // frame per message in send order.
  prioritySync: "priority_sync",
  // compact_v2 (CV1): directory, status and timeline messages in the compact wire encoding of
  // protocol/compact-v2 (feature map by hash, per-message tables, omitted defaults, epoch times).
  // The client undoes it before validation. Old clients keep today's bytes.
  compactV2: "compact_v2",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];

/**
 * Compact hello capabilities (HS1 option b). Bit i of the `cb` hello field (lowercase hex,
 * bit 0 = least significant) means CLIENT_CAPABILITY_BITS[i] is true. APPEND-ONLY: never
 * reorder or remove an entry, or an old client's bits change meaning. Capabilities with a
 * non-boolean value (browser_host) stay in the `capabilities` map. A daemon merges the bits
 * under the map; old daemons ignore `cb`, so a client sends the compact form only to a daemon
 * it knows reads it (one that accepted the msg1 upgrade carrier).
 */
export const CLIENT_CAPABILITY_BITS: readonly ClientCapability[] = [
  CLIENT_CAPS.helloRejection,
  CLIENT_CAPS.sessionTokens,
  CLIENT_CAPS.ownedSubscriptions,
  CLIENT_CAPS.explicitEventSubscriptions,
  CLIENT_CAPS.allProviders,
  CLIENT_CAPS.selectiveAgentTimeline,
  CLIENT_CAPS.reasoningMergeEnum,
  CLIENT_CAPS.customModeIcons,
  CLIENT_CAPS.terminalReflowableSnapshot,
  CLIENT_CAPS.providerSubagents,
  CLIENT_CAPS.projectedSubagentTimeline,
  CLIENT_CAPS.projectUpdates,
  CLIENT_CAPS.compactProviderSnapshots,
  CLIENT_CAPS.providerSnapshotReferences,
  CLIENT_CAPS.timelineReplacementInvalidation,
  CLIENT_CAPS.timelineNotifications,
  CLIENT_CAPS.pluginTimelineItems,
  CLIENT_CAPS.workspaceSetupBlocked,
  CLIENT_CAPS.messageReceivedAck,
  CLIENT_CAPS.compressedFrames,
  CLIENT_CAPS.checkedFrames,
  CLIENT_CAPS.zstdFrames,
  CLIENT_CAPS.agentPatches,
  CLIENT_CAPS.prioritySync,
  CLIENT_CAPS.compactV2,
];

/** Splits a capability map into the `cb` bits (true values of known bits) and the rest. */
export function encodeCompactCapabilities(capabilities: Record<string, unknown>): {
  cb: string;
  rest: Record<string, unknown>;
} {
  // Nibbles, least significant first (no BigInt: older Hermes builds lack it).
  const nibbles: number[] = [];
  const rest: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(capabilities)) {
    const index = CLIENT_CAPABILITY_BITS.indexOf(name as ClientCapability);
    if (index >= 0 && value === true) {
      const n = index >> 2;
      while (nibbles.length <= n) nibbles.push(0);
      nibbles[n]! |= 1 << (index & 3);
    } else if (index < 0 || value !== false) {
      rest[name] = value;
    }
  }
  while (nibbles.length > 1 && nibbles[nibbles.length - 1] === 0) nibbles.pop();
  const cb =
    nibbles.length === 0
      ? "0"
      : nibbles
          .map((n) => n.toString(16))
          .reverse()
          .join("");
  return { cb, rest };
}

/** The `cb` bits as a capability map (unknown high bits from newer clients are ignored). */
export function decodeCompactCapabilities(cb: string): Partial<Record<ClientCapability, true>> {
  const out: Partial<Record<ClientCapability, true>> = {};
  if (!/^[0-9a-f]{1,32}$/.test(cb)) return out;
  CLIENT_CAPABILITY_BITS.forEach((name, index) => {
    const char = cb[cb.length - 1 - (index >> 2)];
    if (char !== undefined && (parseInt(char, 16) >> (index & 3)) & 1) out[name] = true;
  });
  return out;
}
