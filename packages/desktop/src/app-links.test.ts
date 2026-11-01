import { describe, expect, it } from "vitest";
import { AppLinkInbox, parseAppLinkFromArgv, readAppLink } from "./app-links.js";

const PAIR = "dinobot://pair/#offer=eyJ2IjozfQ";
const PROVIDER = "dinobot://provider/add?source=git%3Ahttps%3A%2F%2Fx&name=Pi%20Black&token=t";

describe("app links (public desktop)", () => {
  it("recognises pairing and provider links for the app's scheme only", () => {
    expect(readAppLink(PAIR, "dinobot")).toBe(PAIR);
    expect(readAppLink("DinoBot://pair#offer=abc", "dinobot")).toBe("DinoBot://pair#offer=abc");
    expect(readAppLink(PROVIDER, "dinobot")).toBe(PROVIDER);
    expect(readAppLink(" dinobot://pair/#offer=x ", "dinobot")).toBe("dinobot://pair/#offer=x");
    expect(readAppLink("paseo://pair/#offer=x", "dinobot")).toBeNull();
    expect(readAppLink("dinobot://agent/abc", "dinobot")).toBeNull();
    expect(readAppLink("dinobot://pair/", "dinobot")).toBeNull();
    expect(readAppLink("https://example.com/#offer=x", "dinobot")).toBeNull();
    expect(readAppLink(`dinobot://pair/#offer=${"x".repeat(20_000)}`, "dinobot")).toBeNull();
  });

  it("finds the link among Electron/Chromium argv (Linux xdg-open, second instance)", () => {
    expect(
      parseAppLinkFromArgv(["/opt/DinoBot/DinoBot.bin", "--no-sandbox", PAIR], "dinobot"),
    ).toBe(PAIR);
    expect(parseAppLinkFromArgv(["/opt/DinoBot/DinoBot.bin", "/home/sam/code"], "dinobot")).toBe(
      null,
    );
  });

  it("the inbox keeps the latest link until the renderer takes it, once", () => {
    const inbox = new AppLinkInbox();
    expect(inbox.take()).toBeNull();
    inbox.push("a");
    inbox.push(PAIR);
    expect(inbox.take()).toBe(PAIR);
    expect(inbox.take()).toBeNull();
  });

  it("drops the same link delivered twice within 2 s (macOS launch), keeps a later repeat", () => {
    const inbox = new AppLinkInbox();
    expect(inbox.receive(PAIR, 1_000)).toBe(true);
    expect(inbox.receive(PAIR, 1_500)).toBe(false);
    expect(inbox.take()).toBe(PAIR);
    expect(inbox.take()).toBeNull();
    expect(inbox.receive(PAIR, 9_000)).toBe(true);
    expect(inbox.receive(PROVIDER, 9_100)).toBe(true);
    expect(inbox.take()).toBe(PROVIDER);
  });
});
