import { describe, expect, test } from "vitest";
import { composeSystemPromptParts } from "./system-prompt.js";
import { buildVoiceModeSystemPrompt } from "../voice-config.js";

// What older daemons saved into an agent record when voice mode was turned off.
const RETIRED_OFF_NOTE = [
  "<paseo_voice_mode>",
  "Paseo voice mode is now off. Ignore any earlier Paseo voice mode instructions in this thread.",
  "</paseo_voice_mode>",
].join("\n");

describe("composeSystemPromptParts", () => {
  test("joins non-empty parts", () => {
    expect(composeSystemPromptParts(" a ", null, "", undefined, "b")).toBe("a\n\nb");
    expect(composeSystemPromptParts(null, "  ")).toBeUndefined();
  });

  test("drops the retired voice-off note saved in existing agent records", () => {
    expect(composeSystemPromptParts(`Base prompt\n\n${RETIRED_OFF_NOTE}`, "daemon")).toBe(
      "Base prompt\n\ndaemon",
    );
    expect(composeSystemPromptParts(RETIRED_OFF_NOTE)).toBeUndefined();
    expect(composeSystemPromptParts(`${RETIRED_OFF_NOTE}\n\nBase prompt`)).toBe("Base prompt");
  });

  test("keeps an active voice-on block and the rest of the prompt byte for byte", () => {
    const on = buildVoiceModeSystemPrompt("Base\n\n\n\nprompt", true);
    expect(composeSystemPromptParts(on)).toBe(on);
    expect(on).toContain("Paseo voice mode is now on.");
  });
});
