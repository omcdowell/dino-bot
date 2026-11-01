import { afterEach, expect, it } from "vitest";
import {
  getDeviceCacheMaxBytes,
  getReplicaCacheMaxBytes,
  getSentChatImagesMaxBytes,
} from "./budget";

const MB = 1024 * 1024;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

it("gives the Electron desktop app the same 500 MB cache as the phone", () => {
  (globalThis as { window?: unknown }).window = { paseoDesktop: { platform: "darwin" } };
  expect(getDeviceCacheMaxBytes()).toBe(500 * MB);
});

it("keeps a plain browser tab at 64 MB", () => {
  (globalThis as { window?: unknown }).window = {};
  expect(getDeviceCacheMaxBytes()).toBe(64 * MB);
});

it("splits the device cache between chat rows and sent photos, never more than the total", () => {
  (globalThis as { window?: unknown }).window = { paseoDesktop: { platform: "darwin" } };
  expect(getSentChatImagesMaxBytes()).toBe(100 * MB);
  expect(getReplicaCacheMaxBytes()).toBe(400 * MB);
  expect(getReplicaCacheMaxBytes() + getSentChatImagesMaxBytes()).toBe(500 * MB);
});
