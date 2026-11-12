// What a paired phone holds on to (RU1): the daemon's key (the app pins it), its server id, the
// address it listens on, the password (or its kept hash) and the session-token key. An update or a
// port of the install must leave all of them as they were, or the phone has to pair again.
//
// `dinobot update` takes a snapshot before the swap, checks it again before the restart (fails
// loudly and puts the old version back, no restart) and after it. A manual port (a dist swap into
// an existing install) can do the same from the shell:
//
//   node lib/pairing-identity.mjs snapshot --paseo-home ~/.paseo [--env-file F] > before.json
//   ... swap files ...
//   node lib/pairing-identity.mjs verify before.json   # exit 1 + what changed; restart only on 0
//   ... restart ...
//   node lib/pairing-identity.mjs verify before.json
//
// Only fingerprints (sha256, 16 hex) are kept and printed, never a key, hash or password.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fp = (value) => (value == null ? null : createHash("sha256").update(String(value)).digest("hex").slice(0, 16));

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readJsonOrNull(path) {
  const text = readText(path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
}

function readEnv(path) {
  const out = {};
  for (const line of (path ? readText(path) ?? "" : "").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Field -> human name, for the error. */
export const PAIRING_FIELDS = {
  daemonKey: "daemon key (daemon-keypair.json, pinned by the phone)",
  serverId: "server id (server-id)",
  listen: "listen address (PASEO_LISTEN)",
  paseoHome: "PASEO_HOME",
  password: "password (PASEO_PASSWORD or config.json auth)",
  passwordHash: "kept password hash (daemon-password-hash)",
  sessionTokenKey: "session-token key (session-tokens.json)",
};

/**
 * Fingerprints of what pairing depends on. `paseoHome` is the daemon's PASEO_HOME; `envFile` the
 * daemon env file (DinoBot: ~/.dinobot/daemon.env), if any.
 */
export function pairingIdentity({ paseoHome, envFile = null }) {
  const env = readEnv(envFile);
  const home = env.PASEO_HOME || paseoHome;
  const keypair = readJsonOrNull(join(home, "daemon-keypair.json"));
  const config = readJsonOrNull(join(home, "config.json"));
  const tokens = readJsonOrNull(join(home, "session-tokens.json"));
  return {
    paseoHome: fp(home),
    daemonKey: fp(keypair?.publicKeyB64 ?? (keypair ? "unreadable" : null)),
    serverId: fp(readText(join(home, "server-id"))),
    listen: fp(env.PASEO_LISTEN ?? config?.daemon?.listen ?? null),
    password: fp(env.PASEO_PASSWORD?.trim() || config?.daemon?.auth?.password || null),
    passwordHash: fp(readText(join(home, "daemon-password-hash"))),
    sessionTokenKey: fp(tokens?.key ?? (tokens ? "unreadable" : null)),
  };
}

/**
 * What changed. A field that was set before must be the same after; one that was not set before
 * may appear (a first start writes the token key and the kept hash).
 */
export function pairingDrift(before, after) {
  return Object.keys(PAIRING_FIELDS).filter((k) => before?.[k] != null && before[k] !== after?.[k]);
}

export function describeDrift(drift) {
  return drift.map((k) => PAIRING_FIELDS[k] ?? k).join(", ");
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "snapshot") {
    const paseoHome = arg(rest, "--paseo-home") || process.env.PASEO_HOME;
    if (!paseoHome) {
      console.error("usage: pairing-identity.mjs snapshot --paseo-home DIR [--env-file F]");
      process.exit(2);
    }
    const snap = { paseoHome, envFile: arg(rest, "--env-file") ?? null };
    process.stdout.write(`${JSON.stringify({ ...snap, identity: pairingIdentity(snap) }, null, 2)}\n`);
  } else if (cmd === "verify" && rest[0]) {
    const saved = JSON.parse(readFileSync(rest[0], "utf8"));
    const drift = pairingDrift(saved.identity, pairingIdentity(saved));
    if (drift.length) {
      console.error(`PAIRING WOULD BREAK: changed ${describeDrift(drift)}. Do not restart; put the previous files back.`);
      process.exit(1);
    }
    console.log("pairing identity unchanged");
  } else {
    console.error("usage: pairing-identity.mjs snapshot --paseo-home DIR [--env-file F] | verify SNAPSHOT.json");
    process.exit(2);
  }
}
