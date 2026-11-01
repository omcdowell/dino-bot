import { describe, expect, it } from "vitest";
import { desktopAppLinkRoute } from "./app-link-route";

describe("desktopAppLinkRoute", () => {
  it("pairing link -> /pair with the link and a fresh attempt id (same as the phone)", () => {
    expect(desktopAppLinkRoute("dinobot://pair/#offer=abc", "dinobot", "a1")).toBe(
      `/pair?link=${encodeURIComponent("dinobot://pair/#offer=abc")}&at=a1`,
    );
  });

  it("provider invite -> /provider-link", () => {
    const link = "dinobot://provider/add?source=git%3Ahttps%3A%2F%2Fx&name=Pi&token=t";
    expect(desktopAppLinkRoute(link, "dinobot", "a2")).toMatch(/^\/provider-link\?link=/);
  });

  it("anything else -> null", () => {
    expect(desktopAppLinkRoute("paseo://pair/#offer=abc", "dinobot", "a3")).toBeNull();
    expect(desktopAppLinkRoute("dinobot://agent/x", "dinobot", "a3")).toBeNull();
  });
});
