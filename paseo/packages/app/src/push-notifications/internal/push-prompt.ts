import AsyncStorage from "@react-native-async-storage/async-storage";
import { RELEASE_POLICY } from "@/constants/flavour";
import { createPromptGate } from "./prompt-gate";

/** The app's one notification-prompt gate (prompt-gate.ts), set by the flavour's release policy. */
export const pushPromptGate = createPromptGate({
  storage: AsyncStorage,
  deferUntilFirstReply: RELEASE_POLICY.pushPromptAfterFirstReply,
});
