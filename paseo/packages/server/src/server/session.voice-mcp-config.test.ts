import { describe, expect, test } from "vitest";

import {
  buildVoiceAgentMcpServerConfig,
  buildVoiceModeSystemPrompt,
  stripVoiceModeSystemPrompt,
} from "./voice-config.js";

describe("voice MCP stdio config", () => {
  test("builds stdio MCP config for voice agent", () => {
    const config = buildVoiceAgentMcpServerConfig({
      command: "/usr/local/bin/node",
      baseArgs: ["/tmp/mcp-stdio-socket-bridge-cli.mjs"],
      socketPath: "/tmp/paseo-voice.sock",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_HOME: "/tmp/paseo-home",
      },
    });

    expect(config.type).toBe("stdio");
    expect(config.command).toBe("/usr/local/bin/node");
    expect(config.args).toEqual([
      "/tmp/mcp-stdio-socket-bridge-cli.mjs",
      "--socket",
      "/tmp/paseo-voice.sock",
    ]);
    expect(config.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_HOME: "/tmp/paseo-home",
    });
  });
});

describe("voice mode prompt instructions", () => {
  test("builds enabled voice instructions and preserves base prompt", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("<paseo_voice_mode>");
    expect(prompt).toContain("Paseo voice mode is now on.");
    expect(prompt).toContain("Always use the speak tool for all user-facing communication.");
    expect(prompt).toContain("</paseo_voice_mode>");
  });

  test("voice mode off adds nothing: the base prompt alone, any voice block removed", () => {
    const existing = [
      "Base system prompt",
      "<paseo_voice_mode>",
      "legacy voice instruction",
      "</paseo_voice_mode>",
    ].join("\n\n");

    expect(buildVoiceModeSystemPrompt(existing, false)).toBe("Base system prompt");
    expect(buildVoiceModeSystemPrompt(buildVoiceModeSystemPrompt("Base", true), false)).toBe(
      "Base",
    );
  });

  test("voice mode off with no base prompt gives an empty prompt, which still overrides voice on", () => {
    expect(buildVoiceModeSystemPrompt(undefined, false)).toBe("");
    expect(buildVoiceModeSystemPrompt(buildVoiceModeSystemPrompt(undefined, true), false)).toBe("");
  });

  test("strips voice blocks from persisted prompt", () => {
    const existing = [
      "Base system prompt",
      "<paseo_voice_mode>",
      "legacy voice instruction",
      "</paseo_voice_mode>",
    ].join("\n\n");

    expect(stripVoiceModeSystemPrompt(existing)).toBe("Base system prompt");
    expect(
      stripVoiceModeSystemPrompt(
        ["<paseo_voice_mode>", "legacy voice instruction", "</paseo_voice_mode>"].join("\n\n"),
      ),
    ).toBeUndefined();
  });
});
