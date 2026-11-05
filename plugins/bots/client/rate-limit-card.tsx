import { useRpc, type PluginTimelineItemProps, type PluginTimelineRendererContribution } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { quotaRpc } from "../shared/quota-rpc";
import {
  RATE_LIMIT_CARD_KIND,
  RATE_LIMIT_CARD_VERSION,
  RateLimitCardSchema,
  rateLimitHeadline,
  type QuotaWindow,
  type RateLimitCardData,
} from "./rate-limit-data";

export { rateLimitCardTransformer } from "./rate-limit-data";

/** Usage-report window ids for the usage proxy's window keys. */
const REPORT_WINDOW_ID: Record<QuotaWindow, string> = {
  five_hour: "five_hour",
  seven_day: "weekly",
  seven_day_fable: "weekly_fable",
};

function RateLimitCard({ item, theme, layout }: PluginTimelineItemProps<RateLimitCardData>) {
  const c = theme.colors;
  const data = item.data;
  const fetchQuota = useRpc(quotaRpc);
  const [resetsAt, setResetsAt] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    if (!data.window) return;
    let alive = true;
    fetchQuota({})
      .then((quota) => {
        if (!alive) return undefined;
        const window = quota.windows.find((entry) => entry.id === REPORT_WINDOW_ID[data.window!]);
        setResetsAt(window?.resetsAt ?? null);
        if (window?.usedPct !== null && window?.usedPct !== undefined) {
          setDetail(`${Math.round(window.usedPct)} % of the ${data.window!.replace("_", "-")} window used now`);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [data.window, fetchQuota]);
  return (
    <View
      style={{
        marginVertical: 6,
        marginHorizontal: layout.compact ? 0 : 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.statusWarning,
        borderLeftWidth: 4,
        borderLeftColor: c.statusWarning,
        backgroundColor: c.surface1,
        padding: 12,
      }}
      accessibilityRole="alert"
    >
      <Text style={{ color: c.foreground, fontWeight: "700" }}>{rateLimitHeadline(data, resetsAt)}</Text>
      {detail ? <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 4 }}>{detail}</Text> : null}
      <Text selectable numberOfLines={3} style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 6 }}>
        {data.message}
      </Text>
    </View>
  );
}

export const rateLimitCardRenderer: PluginTimelineRendererContribution<typeof RateLimitCardSchema> = {
  kind: RATE_LIMIT_CARD_KIND,
  version: RATE_LIMIT_CARD_VERSION,
  schema: RateLimitCardSchema,
  Component: RateLimitCard,
};
