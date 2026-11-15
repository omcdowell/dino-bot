// The pairing QR offers the MagicDNS name first (offerEndpoints); the daemon refuses a Host it does not allow
// ("disallowed host"). Every setup path writes daemon.hostnames with ".ts.net" (writeDaemonConfig), so the name in
// the QR is accepted. (A hand-made daemon config without it refuses the name: "disallowed host".)
//   node --test test/offer-hostnames.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeDaemonConfig } from "../lib/config.mjs";
import { offerEndpoints } from "../lib/offer.mjs";
import { layout } from "../lib/util.mjs";

/** The daemon's rule (paseo server/hostnames.ts matchesHostnamePattern) for a ".suffix" pattern or an exact name. */
const allowed = (host, patterns) =>
  patterns.some((p) => (p.startsWith(".") ? host === p.slice(1) || host.endsWith(p) : host === p));

describe("pairing offer vs daemon.hostnames", () => {
  it("setup writes .ts.net and every name the QR offers matches it", () => {
    const home = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      const L = layout({ HOME: home });
      writeDaemonConfig(L, { mainModel: null });
      const cfg = JSON.parse(readFileSync(join(L.paseoHome, "config.json"), "utf8"));
      assert.ok(cfg.daemon.hostnames.includes(".ts.net"));
      const endpoints = offerEndpoints({ port: 6767, tailscale: { running: true, dnsName: "sams-laptop.tail0000.ts.net", ip: "100.64.0.5" } });
      for (const e of endpoints.filter((x) => !/^\d/.test(x))) assert.ok(allowed(e.split(":")[0], cfg.daemon.hostnames), e);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a setup run again (sign-in from the phone, update) keeps the user's own names and drops .local", () => {
    const home = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      const L = layout({ HOME: home });
      mkdirSync(L.paseoHome, { recursive: true });
      writeFileSync(join(L.paseoHome, "config.json"), JSON.stringify({ daemon: { hostnames: ["my.box", ".local"] } }));
      writeDaemonConfig(L, { mainModel: null });
      writeDaemonConfig(L, { mainModel: "x/y" });
      assert.deepEqual(JSON.parse(readFileSync(join(L.paseoHome, "config.json"), "utf8")).daemon.hostnames, ["my.box", ".ts.net"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
