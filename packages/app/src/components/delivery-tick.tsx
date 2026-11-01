import { memo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertCircle, Check, CheckCheck, Clock, HelpCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";

/**
 * WhatsApp-style delivery state of a user message:
 * clock (only on this device) → single tick (the daemon has it) → grey double (the daemon is
 * holding it for the agent) → blue double (the agent has it). "!" = not sent, "?" = unknown.
 */
export type DeliveryState = "clock" | "single" | "queued" | "taken" | "failed" | "unknown";

const TICK_SIZE = 14;

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const takenColor = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const failedColor = (theme: Theme) => ({ color: theme.colors.destructive });

const MutedClock = withUnistyles(Clock, mutedColor);
const MutedCheck = withUnistyles(Check, mutedColor);
const MutedCheckCheck = withUnistyles(CheckCheck, mutedColor);
const TakenCheckCheck = withUnistyles(CheckCheck, takenColor);
const FailedAlert = withUnistyles(AlertCircle, failedColor);
const MutedHelp = withUnistyles(HelpCircle, mutedColor);

export function deliveryStateLabelKey(state: DeliveryState): string {
  switch (state) {
    case "clock":
      return "delivery.state.waiting";
    case "single":
      return "delivery.state.received";
    case "queued":
      return "delivery.state.queued";
    case "taken":
      return "delivery.state.taken";
    case "failed":
      return "delivery.state.failed";
    case "unknown":
      return "delivery.state.unknown";
  }
}

function TickIcon({ state }: { state: DeliveryState }) {
  switch (state) {
    case "clock":
      return <MutedClock size={TICK_SIZE - 2} strokeWidth={2.2} />;
    case "single":
      return <MutedCheck size={TICK_SIZE} strokeWidth={2.4} />;
    case "queued":
      return <MutedCheckCheck size={TICK_SIZE} strokeWidth={2.4} />;
    case "taken":
      return <TakenCheckCheck size={TICK_SIZE} strokeWidth={2.4} />;
    case "failed":
      return <FailedAlert size={TICK_SIZE} strokeWidth={2.2} />;
    case "unknown":
      return <MutedHelp size={TICK_SIZE} strokeWidth={2.2} />;
  }
}

export const DeliveryTick = memo(function DeliveryTick({ state }: { state: DeliveryState }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.slot}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t(deliveryStateLabelKey(state))}
      testID={`delivery-tick-${state}`}
    >
      <TickIcon state={state} />
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  // Fixed width so the row does not shift as the tick changes.
  slot: {
    width: TICK_SIZE + 4,
    height: TICK_SIZE + 2,
    alignItems: "center",
    justifyContent: "center",
  },
}));
