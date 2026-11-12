/**
 * Noise msg1 carried in the WebSocket upgrade (HS1). Same pattern, keys, prologue,
 * payload and msg2 checks as the in-band hello; only the carrier differs. Every
 * failure here must match the in-band failure for the same fault.
 * See docs/perf/priority-sync/handshake-security.md.
 */
import { describe, expect, it, vi } from "vitest";
import {
  openClientSecureChannel,
  openDaemonSecureChannel,
  prepareClientSecureHandshake,
  readUpgradeCarrier,
  UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL,
  UPGRADE_CARRIER_MSG1_PREFIX,
  type SecureChannel,
} from "./secure-channel.js";
import type { Transport } from "./encrypted-channel.js";
import { exportPublicKey, generateKeyPair } from "./crypto.js";
import { base64ToArrayBuffer } from "./base64.js";

interface Frame {
  data: string | ArrayBuffer;
  isBinary: boolean;
}
type Interceptor = (frame: Frame) => Frame | null;

function createLink() {
  const toDaemon: Frame[] = [];
  const toClient: Frame[] = [];
  let interceptToDaemon: Interceptor = (frame) => frame;
  let interceptToClient: Interceptor = (frame) => frame;
  const daemon: Transport = {
    send: vi.fn((data: string | ArrayBuffer) => {
      const recorded = { data, isBinary: data instanceof ArrayBuffer };
      toClient.push(recorded);
      const frame = interceptToClient(recorded);
      if (frame) setTimeout(() => client.onmessage?.(frame), 0);
    }),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const client: Transport = {
    send: vi.fn((data: string | ArrayBuffer) => {
      const recorded = { data, isBinary: data instanceof ArrayBuffer };
      toDaemon.push(recorded);
      const frame = interceptToDaemon(recorded);
      if (frame) setTimeout(() => daemon.onmessage?.(frame), 0);
    }),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return {
    daemon,
    client,
    toDaemon,
    toClient,
    setToDaemon: (fn: Interceptor) => (interceptToDaemon = fn),
    setToClient: (fn: Interceptor) => (interceptToClient = fn),
  };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function carrierOf(protocols: readonly string[]): string {
  const carried = readUpgradeCarrier(protocols);
  if (typeof carried !== "string") throw new Error("no carrier");
  return carried;
}

function tamper(protocols: readonly string[], index: number): string[] {
  return protocols.map((p) => {
    if (!p.startsWith(UPGRADE_CARRIER_MSG1_PREFIX)) return p;
    const body = p.slice(UPGRADE_CARRIER_MSG1_PREFIX.length);
    const c = body[index]!;
    const swapped = c === "A" ? "B" : "A";
    return UPGRADE_CARRIER_MSG1_PREFIX + body.slice(0, index) + swapped + body.slice(index + 1);
  });
}

async function openCarriedPair() {
  const link = createLink();
  const daemonKeyPair = generateKeyPair();
  const daemonPublicKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
  const prepared = prepareClientSecureHandshake(daemonPublicKeyB64);
  const daemonReceived: Array<string | ArrayBuffer> = [];
  const clientReceived: Array<string | ArrayBuffer> = [];
  let opened!: () => void;
  const openedPromise = new Promise<void>((r) => (opened = r));
  const outcome = vi.fn();
  const daemonPromise = openDaemonSecureChannel(link.daemon, {
    daemonKeyPair,
    minimumMode: "protected",
    carriedMsg1: carrierOf(prepared.upgradeProtocols),
    events: { onmessage: (data) => daemonReceived.push(data) },
  });
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64,
    minimumMode: "protected",
    prepared,
    carrier: "accepted",
    onCarrierOutcome: outcome,
    events: {
      onopen: () => opened(),
      onmessage: (data) => clientReceived.push(data),
    },
  });
  const daemon: SecureChannel = await daemonPromise;
  await openedPromise;
  return {
    link,
    daemonKeyPair,
    prepared,
    client,
    daemon,
    daemonReceived,
    clientReceived,
    outcome,
  };
}

describe("upgrade carrier: happy path", () => {
  it("opens protected with the daemon's ready as the first frame and no in-band hello", async () => {
    const pair = await openCarriedPair();
    expect(pair.client.securityMode()).toBe("protected");
    expect(pair.daemon.securityMode()).toBe("protected");
    expect(pair.prepared.upgradeProtocols[0]).toBe(UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL);
    expect(pair.link.toDaemon).toHaveLength(0);
    expect(JSON.parse(pair.link.toClient[0]!.data as string).type).toBe("e2ee_ready");
    expect(pair.outcome).toHaveBeenCalledWith(true);
    await pair.client.send("hello daemon");
    await pair.daemon.send("hello client");
    await settle();
    expect(pair.daemonReceived).toEqual(["hello daemon"]);
    expect(pair.clientReceived).toEqual(["hello client"]);
    // Records are ciphertext, never plaintext JSON.
    for (const frame of pair.link.toDaemon) expect(String(frame.data)).not.toContain("hello");
  });

  it("carries exactly the msg1 the in-band hello would carry (same transcript)", async () => {
    const link = createLink();
    const daemonPublicKeyB64 = exportPublicKey(generateKeyPair().publicKey);
    const prepared = prepareClientSecureHandshake(daemonPublicKeyB64);
    await openClientSecureChannel(link.client, {
      daemonPublicKeyB64,
      prepared,
      carrier: "ignored",
    });
    const hello = JSON.parse(link.toDaemon[0]!.data as string);
    expect(hello.protected.message).toBe(carrierOf(prepared.upgradeProtocols));
    // NK msg1: 32-byte ephemeral + encrypted 2-byte parameter payload + 16-byte tag. No app data.
    expect(base64ToArrayBuffer(hello.protected.message).byteLength).toBe(50);
  });

  it("a prepared handshake is single use and bound to its daemon key", async () => {
    const key = exportPublicKey(generateKeyPair().publicKey);
    const prepared = prepareClientSecureHandshake(key);
    await expect(
      openClientSecureChannel(createLink().client, {
        daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
        prepared,
      }),
    ).rejects.toThrow(/another daemon key/);
    await openClientSecureChannel(createLink().client, {
      daemonPublicKeyB64: key,
      prepared,
    });
    await expect(
      openClientSecureChannel(createLink().client, {
        daemonPublicKeyB64: key,
        prepared,
      }),
    ).rejects.toThrow(/already used/);
  });
});

describe("upgrade carrier: failures match in-band", () => {
  it("tampered carried msg1 is refused, as a tampered in-band msg1 is", async () => {
    const daemonKeyPair = generateKeyPair();
    const key = exportPublicKey(daemonKeyPair.publicKey);
    for (const index of [0, 20, 45, 60]) {
      const prepared = prepareClientSecureHandshake(key);
      const tampered = carrierOf(tamper(prepared.upgradeProtocols, index));
      const link = createLink();
      await expect(
        openDaemonSecureChannel(link.daemon, {
          daemonKeyPair,
          carriedMsg1: tampered,
        }),
      ).rejects.toThrow();
      expect(link.daemon.send).not.toHaveBeenCalled();

      // In-band control: the same tampered msg1 inside an e2ee_hello.
      const inband = createLink();
      const daemonPromise = openDaemonSecureChannel(inband.daemon, {
        daemonKeyPair,
      });
      inband.daemon.onmessage?.({
        data: JSON.stringify({
          type: "e2ee_hello",
          key,
          protected: { v: 1, message: tampered },
        }),
        isBinary: false,
      });
      await expect(daemonPromise).rejects.toThrow();
      expect(inband.daemon.send).not.toHaveBeenCalled();
    }
  });

  it("msg1 for the wrong static key is refused, as in-band", async () => {
    const daemonKeyPair = generateKeyPair();
    const other = exportPublicKey(generateKeyPair().publicKey);
    const prepared = prepareClientSecureHandshake(other);
    const link = createLink();
    await expect(
      openDaemonSecureChannel(link.daemon, {
        daemonKeyPair,
        carriedMsg1: carrierOf(prepared.upgradeProtocols),
      }),
    ).rejects.toThrow();
    expect(link.daemon.send).not.toHaveBeenCalled();

    const inband = createLink();
    const daemonPromise = openDaemonSecureChannel(inband.daemon, {
      daemonKeyPair,
    });
    await openClientSecureChannel(inband.client, { daemonPublicKeyB64: other });
    await expect(daemonPromise).rejects.toThrow();
    expect(inband.daemon.send).not.toHaveBeenCalled();
  });

  it("a client that pinned the wrong key fails msg2, as in-band", async () => {
    // Daemon B answers a msg1 meant for A? It cannot: B cannot decrypt it (above).
    // Here an attacker answers with its own valid-looking ready: the client rejects msg2.
    const link = createLink();
    const realKey = exportPublicKey(generateKeyPair().publicKey);
    const prepared = prepareClientSecureHandshake(realKey);
    const attacker = generateKeyPair();
    const attackerPrepared = prepareClientSecureHandshake(exportPublicKey(attacker.publicKey));
    // The attacker completes a handshake with itself and replays that ready to our client.
    const side = createLink();
    void openDaemonSecureChannel(side.daemon, {
      daemonKeyPair: attacker,
      carriedMsg1: carrierOf(attackerPrepared.upgradeProtocols),
    }).catch(() => {});
    await settle();
    const forgedReady = side.toClient[0]!.data as string;
    await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: realKey,
      prepared,
      carrier: "accepted",
    });
    link.client.onmessage?.({ data: forgedReady, isBinary: false });
    await settle();
    expect(link.client.close).toHaveBeenCalledWith(4002, expect.any(String));
  });

  it("a replayed upgrade gets a fresh msg2 and its recorded records are refused (1011)", async () => {
    const first = await openCarriedPair();
    await first.client.send("secret command");
    await first.client.send(new Uint8Array([1, 2, 3]).buffer);
    await settle();
    expect(first.daemonReceived).toHaveLength(2);
    const records = first.link.toDaemon.slice();
    const replayedMsg1 = carrierOf(first.prepared.upgradeProtocols);

    const link = createLink();
    const replayed: Array<string | ArrayBuffer> = [];
    const daemon = await openDaemonSecureChannel(link.daemon, {
      daemonKeyPair: first.daemonKeyPair,
      carriedMsg1: replayedMsg1,
      events: { onmessage: (data) => replayed.push(data) },
    });
    // Fresh responder ephemeral: the replayed session's ready differs from the original.
    expect(link.toClient[0]!.data).not.toBe(first.link.toClient[0]!.data);
    for (const frame of records) link.daemon.onmessage?.(frame);
    await settle();
    expect(daemon.securityMode()).toBe("protected");
    expect(replayed).toEqual([]);
    expect(link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it("an in-band hello with a different msg1 on a carried channel closes it (1008), as in-band", async () => {
    const pair = await openCarriedPair();
    const other = prepareClientSecureHandshake(exportPublicKey(pair.daemonKeyPair.publicKey));
    await openClientSecureChannel(pair.link.client, {
      daemonPublicKeyB64: exportPublicKey(pair.daemonKeyPair.publicKey),
      prepared: other,
      carrier: "ignored",
    }).catch(() => {});
    await settle();
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1008, expect.stringContaining("mismatch"));
  });

  it("malformed carriers are refused, never ignored", () => {
    expect(readUpgradeCarrier(["paseo.e2ee.v1"])).toBeNull();
    const msg1 = "A".repeat(67);
    for (const protocols of [
      [`${UPGRADE_CARRIER_MSG1_PREFIX}${msg1}`, `${UPGRADE_CARRIER_MSG1_PREFIX}${msg1}`],
      [`${UPGRADE_CARRIER_MSG1_PREFIX}`],
      [`${UPGRADE_CARRIER_MSG1_PREFIX}AAA=`],
      [`${UPGRADE_CARRIER_MSG1_PREFIX}AA+A`],
      [`${UPGRADE_CARRIER_MSG1_PREFIX}${"A".repeat(400)}`],
      // Non-canonical: trailing bits set in the last character.
      [`${UPGRADE_CARRIER_MSG1_PREFIX}AB`],
    ]) {
      expect(readUpgradeCarrier(protocols)).toBeInstanceOf(Error);
    }
  });
});

describe("upgrade carrier: downgrade and fallback", () => {
  it("daemon ignored the carrier (old daemon): msg1 goes in-band at once, still protected", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonPublicKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const prepared = prepareClientSecureHandshake(daemonPublicKeyB64);
    const received: string[] = [];
    // Old daemon: no carriedMsg1, reads the in-band hello.
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair,
      events: { onmessage: (d) => received.push(String(d)) },
    });
    let opened!: () => void;
    const openedPromise = new Promise<void>((r) => (opened = r));
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64,
      minimumMode: "protected",
      prepared,
      carrier: "ignored",
      events: { onopen: () => opened() },
    });
    expect(link.toDaemon).toHaveLength(1);
    expect(JSON.parse(link.toDaemon[0]!.data as string).type).toBe("e2ee_hello");
    const daemon = await daemonPromise;
    await openedPromise;
    expect(client.securityMode()).toBe("protected");
    expect(daemon.securityMode()).toBe("protected");
    await client.send('{"type":"hello","password":"x"}');
    await settle();
    expect(received).toEqual(['{"type":"hello","password":"x"}']);
    for (const frame of link.toDaemon.slice(1))
      expect(String(frame.data)).not.toContain("password");
  });

  it("selected subprotocol unknown and daemon silent: in-band after 1 s, still protected", async () => {
    vi.useFakeTimers();
    try {
      const link = createLink();
      const daemonKeyPair = generateKeyPair();
      const daemonPublicKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
      const prepared = prepareClientSecureHandshake(daemonPublicKeyB64);
      const daemonPromise = openDaemonSecureChannel(link.daemon, {
        daemonKeyPair,
      });
      const outcome = vi.fn();
      const client = await openClientSecureChannel(link.client, {
        daemonPublicKeyB64,
        minimumMode: "protected",
        prepared,
        carrier: "unknown",
        onCarrierOutcome: outcome,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(link.toDaemon).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(link.toDaemon).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      await daemonPromise;
      expect(client.isOpen()).toBe(true);
      expect(client.securityMode()).toBe("protected");
      expect(outcome).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carrier accepted but the ready was lost: the in-band retry (same msg1) gets the same ready", async () => {
    vi.useFakeTimers();
    try {
      const link = createLink();
      const daemonKeyPair = generateKeyPair();
      const daemonPublicKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
      const prepared = prepareClientSecureHandshake(daemonPublicKeyB64);
      let dropped = 0;
      link.setToClient((frame) => (dropped++ === 0 ? null : frame));
      const daemonPromise = openDaemonSecureChannel(link.daemon, {
        daemonKeyPair,
        carriedMsg1: carrierOf(prepared.upgradeProtocols),
      });
      const client = await openClientSecureChannel(link.client, {
        daemonPublicKeyB64,
        prepared,
        carrier: "accepted",
      });
      await vi.advanceTimersByTimeAsync(10);
      await daemonPromise;
      expect(client.isOpen()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(10);
      expect(client.isOpen()).toBe(true);
      expect(link.toClient).toHaveLength(2);
      expect(link.toClient[1]!.data).toBe(link.toClient[0]!.data);
    } finally {
      vi.useRealTimers();
    }
  });
});
