import { describe, expect, it, vi } from "vitest";
import { PLUGIN_LIST_TTL_MS, pluginAvailable } from "./plugin-available";

describe("pluginAvailable (rel-demo bug 8)", () => {
  it("true only for a running plugin in the host's list", async () => {
    const client = {
      listPlugins: vi.fn(async () => [
        { id: "bots", status: "running" },
        { id: "apns", status: "failed" },
      ]),
    };
    expect(await pluginAvailable(client, "bots")).toBe(true);
    expect(await pluginAvailable(client, "apns")).toBe(false);
    expect(await pluginAvailable(client, "nope")).toBe(false);
    expect(client.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("lists again after the cache time", async () => {
    let t = 0;
    const client = {
      listPlugins: vi.fn(async () => [] as Array<{ id: string; status: string }>),
    };
    expect(await pluginAvailable(client, "apns", () => t)).toBe(false);
    client.listPlugins.mockResolvedValue([{ id: "apns", status: "running" }]);
    t = PLUGIN_LIST_TTL_MS + 1;
    expect(await pluginAvailable(client, "apns", () => t)).toBe(true);
    expect(client.listPlugins).toHaveBeenCalledTimes(2);
  });

  it("unknown (list fails or is missing): callers try the call as before", async () => {
    const failing = {
      listPlugins: vi.fn(async () => Promise.reject(new Error("offline"))),
    };
    expect(await pluginAvailable(failing, "apns")).toBe(true);
    expect(await pluginAvailable({}, "apns")).toBe(true);
  });
});
