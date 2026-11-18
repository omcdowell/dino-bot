import { describe, expect, test } from "vitest";

import { buildProviderCommand } from "@/utils/provider-command-templates";

describe("buildProviderCommand", () => {
  test("builds Hermes resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "hermes",
        id: "resume",
        sessionId: "20260813_111500_abc123",
      }),
    ).toBe("hermes --resume 20260813_111500_abc123");
  });

  test("builds Pi resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "pi",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("pi --session ses_abc123");
  });
});
