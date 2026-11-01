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
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
