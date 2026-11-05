// AV4 byte measurement: one phone-home refresh with 10 bots, unchanged vs one avatar changed, for the client
// before AV4 (full avatar.png on a change) and with AV4 (PNG of the slot's size, or avatar.json drawn on the
// phone). Bytes are the JSON of each RPC request + answer (no websocket framing or compression).
// Run: npx tsx scripts/avatar/cache-bytes.ts [--json out.json]
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import { AVATAR_PACK, AVATAR_PACK_JSON } from "../../shared/avatar";
import type { AvatarNeed } from "../../client/avatar-cache";
import { FakeHost, fixtureAvatars, refreshHome, tenBots, type HostOptions } from "../../test/avatar-sim";

async function scenario(name: string, need: AvatarNeed, options: HostOptions = {}) {
  const host = new FakeHost(tenBots(), options);
  const client = new QueryClient();
  const step = async (label: string) => {
    host.bytes = 0;
    host.listBytes = 0;
    host.calls = [];
    await refreshHome(client, host, need);
    return { step: label, list: host.listBytes, avatarCalls: host.calls.length, avatarBytes: host.bytes };
  };
  const cold = await step("first open (empty phone)");
  await client.invalidateQueries();
  const unchanged = await step("refresh, unchanged");
  host.bots[3] = { ...host.bots[3]!, json: { ...fixtureAvatars()[9]!, revision: 7 } };
  const changed = await step("refresh, one changed");
  const device = JSON.stringify(dehydrate(client)).length;
  return { name, steps: [cold, unchanged, changed], deviceBytes: device };
}

async function main() {
const results = [
  await scenario("before AV4: full avatar.png (512) on a change", {}, { sizes: false }),
  await scenario("AV4 PNG, 64 px slot (group rows, 18-40 pt)", { size: 64 }),
  await scenario("AV4 PNG, 128 px slot (home rows, 44-80 pt)", { size: 128 }),
  await scenario("AV4 PNG, 512 px slot (96 pt edit sheet)", { size: 512 }),
  await scenario("AV4 avatar.json drawn on the phone (any size)", { size: 128, pack: AVATAR_PACK }),
];

const pack = { raw: AVATAR_PACK_JSON.length, gzip: gzipSync(AVATAR_PACK_JSON, { level: 9 }).length };

for (const r of results) {
  console.log(`\n${r.name}   (device copy ${r.deviceBytes.toLocaleString()} B)`);
  for (const s of r.steps)
    console.log(
      `  ${s.step.padEnd(26)} bots.list ${String(s.list).padStart(6)} B   avatar ${String(s.avatarCalls).padStart(2)} calls ${String(s.avatarBytes).padStart(8)} B   total ${String(s.list + s.avatarBytes).padStart(8)} B`,
    );
}
console.log(`\npack download (once, only when the server's pack is newer): ${pack.raw} B JSON, ${pack.gzip} B gzip -9`);

const out = process.argv.indexOf("--json");
if (out > 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, JSON.stringify({ results, pack }, null, 2));
}

void main();
