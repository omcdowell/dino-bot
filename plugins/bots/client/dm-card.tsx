import { useAgent } from "@getpaseo/plugin/client";
import type {
  PluginClientOpenPanelOptions,
  PluginOpenScreenInput,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
} from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { DM_CARD_KIND, DM_CARD_VERSION, DmCardSchema, type DmCardData } from "./dm-card-data";
import { ULID_RE } from "../shared/dm-schema";
import { focusDmThread } from "./dms-focus";
import { DMS_PANEL_ID, HOP_WARN, explorerHostsPanels, partyLabel } from "./dms-format";
import { accentText } from "./accent";

export { dmCardTransformer } from "./dm-card-data";

const COLLAPSED_LINES = 12;

export interface DmCardNavigation {
  openScreen(input: PluginOpenScreenInput): void;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
}

export function makeDmCardRenderer(nav: DmCardNavigation): PluginTimelineRendererContribution<typeof DmCardSchema> {
  function DmCard({ item, theme, layout, agentId }: PluginTimelineItemProps<DmCardData>) {
    const c = theme.colors;
    const dm = item.data;
    const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
    // "Thread" opens the DMs panel in this workspace's Explorer; the DMs screen where the Explorer
    // cannot host plugin panels (phone app, narrow web) or if opening the panel fails.
    const openThread = () => {
      if (workspaceId && explorerHostsPanels(layout)) {
        try {
          focusDmThread(dm.to, { messageId: dm.id });
          nav.openPanel(DMS_PANEL_ID, { workspaceId, location: "explorer" });
          return;
        } catch {
          // fall through to the screen
        }
      }
      nav.openScreen({ screenId: "dms", params: { botId: dm.to, message: dm.id } });
    };
    const [expanded, setExpanded] = useState(false);
    const long = dm.body.split("\n").length > COLLAPSED_LINES || dm.body.length > 1200;
    const warn = dm.kind === "escalate" || dm.hop >= HOP_WARN;
    const meta = [dm.kind, `hop ${dm.hop}`, dm.expects_reply ? "expects reply" : null].filter(Boolean).join(" · ");
    return (
      <View
        style={{
          marginVertical: 6,
          marginHorizontal: layout.compact ? 0 : 4,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: warn ? c.statusWarning : c.border,
          borderLeftWidth: 4,
          borderLeftColor: warn ? c.statusWarning : accentText(c),
          backgroundColor: c.surface1,
          padding: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          <Text style={{ color: c.foreground, fontWeight: "700", marginRight: 8 }}>DM from {partyLabel(dm.from)}</Text>
          <Text style={{ color: warn ? c.statusWarning : c.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{meta}</Text>
          <View style={{ flex: 1 }} />
          {ULID_RE.test(dm.id) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open this DM thread"
            onPress={openThread}
            style={({ pressed }) => ({ paddingVertical: 2, paddingHorizontal: 6, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ color: accentText(c), fontSize: 12, fontWeight: "600" }}>Thread</Text>
          </Pressable>
          ) : null}
        </View>
        {dm.note ? (
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, fontStyle: "italic", marginTop: 6 }}>
            {dm.note}
          </Text>
        ) : null}
        {dm.body ? (
          <Text
            selectable
            numberOfLines={long && !expanded ? COLLAPSED_LINES : undefined}
            style={{ color: c.foreground, marginTop: 8, lineHeight: 20 }}
          >
            {dm.body}
          </Text>
        ) : null}
        {long ? (
          <Pressable accessibilityRole="button" onPress={() => setExpanded((v) => !v)} style={{ marginTop: 6 }}>
            <Text style={{ color: accentText(c), fontSize: 12 }}>{expanded ? "Show less" : "Show all"}</Text>
          </Pressable>
        ) : null}
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, marginTop: 6 }}>
          {dm.id}
          {dm.re ? ` · re ${dm.re}` : ""}
        </Text>
      </View>
    );
  }
  return { kind: DM_CARD_KIND, version: DM_CARD_VERSION, schema: DmCardSchema, Component: DmCard };
}
