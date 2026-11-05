import { describe, expect, it } from "vitest";
import {
  isTailnetEndpoint,
  pairLinkFromIncoming,
  routeForIncoming,
  providerAddCommand,
  providerInviteFromIncoming,
  providerRouteForIncoming,
  tailnetOnlyEndpoints,
} from "./pair-deep-link";

describe("pairing deep link", () => {
  it("accepts <scheme>://pair/#offer= with the app's own scheme", () => {
    expect(pairLinkFromIncoming("dinobot://pair/#offer=abc", "dinobot")).toBe(
      "dinobot://pair/#offer=abc",
    );
    expect(pairLinkFromIncoming("dinobot://pair#offer=abc", "dinobot")).toBe(
      "dinobot://pair/#offer=abc",
    );
    expect(pairLinkFromIncoming("paseo://pair/#offer=abc", "paseo")).toBe(
      "paseo://pair/#offer=abc",
    );
  });
  it("accepts a bare router path", () => {
    expect(pairLinkFromIncoming("/pair#offer=abc", "dinobot")).toBe("dinobot://pair/#offer=abc");
  });
  it("ignores other schemes, other routes and links without an offer", () => {
    expect(pairLinkFromIncoming("paseo://pair/#offer=abc", "dinobot")).toBeNull();
    expect(pairLinkFromIncoming("dinobot://settings#offer=abc", "dinobot")).toBeNull();
    expect(pairLinkFromIncoming("dinobot://pair/", "dinobot")).toBeNull();
    expect(routeForIncoming("/h/abc/settings", "dinobot")).toBeNull();
  });
  it("routes to /pair with the link encoded", () => {
    expect(routeForIncoming("dinobot://pair/#offer=a+b", "dinobot")).toBe(
      `/pair?link=${encodeURIComponent("dinobot://pair/#offer=a+b")}`,
    );
  });
  it("the same link opened again is a new route (attempt id), so /pair restarts (bug 7)", () => {
    const first = routeForIncoming("dinobot://pair/#offer=a", "dinobot", "k1-1");
    const again = routeForIncoming("dinobot://pair/#offer=a", "dinobot", "k1-2");
    expect(first).toBe(`/pair?link=${encodeURIComponent("dinobot://pair/#offer=a")}&at=k1-1`);
    expect(again).not.toBe(first);
  });
});

describe("Tailscale only", () => {
  it("keeps MagicDNS names and 100.64/10 addresses, drops LAN, .local and localhost", () => {
    expect(
      tailnetOnlyEndpoints([
        "box.tail1.ts.net:6767",
        "100.64.0.12:6767",
        "box.local:6767",
        "192.168.1.20:6767",
        "localhost:6767",
      ]),
    ).toEqual(["box.tail1.ts.net:6767", "100.64.0.12:6767"]);
    expect(isTailnetEndpoint("100.20.0.1:6767")).toBe(false);
  });
  it("refuses a code with no Tailscale address", () => {
    expect(() => tailnetOnlyEndpoints(["192.168.1.20:6767"])).toThrow(/Tailscale/);
  });
});

describe("provider invite links (private provider packages)", () => {
  const link =
    "dinobot://provider/add?source=git%3Agithub.com%2Fowner%2Fpi-x%40v1&name=Pi+X&token=github_pat_ABCDEFGHIJKLMNOPQRSTUV";
  it("parses name and source, and never exposes the token", () => {
    const invite = providerInviteFromIncoming(link, "dinobot");
    expect(invite).toMatchObject({
      name: "Pi X",
      source: "git:github.com/owner/pi-x@v1",
      hasToken: true,
    });
    expect(JSON.stringify({ name: invite?.name, source: invite?.source })).not.toContain(
      "github_pat",
    );
  });
  it("routes to /provider-link and builds the computer command", () => {
    expect(providerRouteForIncoming(link, "dinobot")).toBe(
      `/provider-link?link=${encodeURIComponent(link)}`,
    );
    const invite = providerInviteFromIncoming(link, "dinobot")!;
    expect(providerAddCommand(invite, "dinobot")).toBe(`dinobot provider add '${link}'`);
    expect(
      providerAddCommand({ ...invite, link: "dinobot://provider/add?source=a'b" }, "dinobot"),
    ).toBe("dinobot provider add 'dinobot://provider/add?source=a'\\''b'");
  });
  it("a partly decoded link (as the router may pass it) still gives a well-formed link", () => {
    const decoded =
      "dinobot://provider/add?source=git:https://github.com/o/p@v1&name=Pi X&token=github_pat_ABCDEFGHIJKLMNOPQRSTUV";
    const invite = providerInviteFromIncoming(decoded, "dinobot")!;
    const back = new URL(invite.link);
    expect(back.searchParams.get("source")).toBe("git:https://github.com/o/p@v1");
    expect(back.searchParams.get("name")).toBe("Pi X");
    expect(invite.link).not.toContain(" ");
  });
  it("ignores other links and incomplete ones", () => {
    expect(providerInviteFromIncoming("dinobot://pair/#offer=x", "dinobot")).toBeNull();
    expect(providerInviteFromIncoming("dinobot://provider/add", "dinobot")).toBeNull();
    expect(providerInviteFromIncoming("paseo://provider/add?source=npm:x", "dinobot")).toBeNull();
    expect(providerInviteFromIncoming("/provider/add?source=npm%3Ax", "dinobot")?.source).toBe(
      "npm:x",
    );
  });
});
