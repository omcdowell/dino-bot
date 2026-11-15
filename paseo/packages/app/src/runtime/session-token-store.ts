import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonSessionTokenStore } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";

/**
 * Per-device session tokens, one per host connection (serverId + connection id). After one
 * password check the daemon issues a token; presenting it on later connects skips the daemon's
 * ~280 ms bcrypt check. The main client and the connection probes of a host share one entry, as
 * the daemon keeps one token per clientId and channel. Kept next to the host registry (which holds
 * the password itself) and dropped with the host. A token the daemon refuses is dropped by the
 * client, which then connects with the password.
 */

const STORAGE_KEY = "@paseo:session-tokens-v1";
const StoredSchema = z.record(
  z.string(),
  z.object({ token: z.string().min(1).max(256), device: z.boolean().optional() }),
);

export interface SessionTokenPersistence {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface SessionTokenRegistry {
  storeFor(input: { serverId: string; connectionId: string }): DaemonSessionTokenStore;
  forgetServer(serverId: string): void;
  /**
   * QR2: called with the serverId once a device token for it is safely stored (the device then
   * needs no password for that host). Returns an unsubscribe.
   */
  onDeviceToken(listener: (serverId: string) => void): () => void;
  /** Resolves once stored tokens are loaded (connects before then use the password). */
  ready: Promise<void>;
}

function keyFor(serverId: string, connectionId: string): string {
  return JSON.stringify([serverId, connectionId]);
}

export function createSessionTokenRegistry(storage: SessionTokenPersistence): SessionTokenRegistry {
  const tokens = new Map<string, string>();
  const deviceKeys = new Set<string>();
  const deviceListeners = new Set<(serverId: string) => void>();
  let writeChain: Promise<void> = Promise.resolve();
  let loaded = false;

  const persist = (): Promise<boolean> => {
    const snapshot: Record<string, { token: string; device?: boolean }> = {};
    for (const [key, token] of tokens) {
      snapshot[key] = deviceKeys.has(key) ? { token, device: true } : { token };
    }
    const write = writeChain.then(async () => {
      await storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      return true;
    });
    const written = write.catch(() => false);
    writeChain = written.then(() => undefined);
    return written;
  };

  const notifyDevice = (key: string, written: Promise<boolean>) => {
    const [serverId] = JSON.parse(key) as [string, string];
    void (async () => {
      // Only once the token is on disk: the password is the fallback until then.
      if (!(await written) || !deviceKeys.has(key)) return;
      for (const listener of deviceListeners) listener(serverId);
    })();
  };

  const ready = (async () => {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) {
        for (const [key, value] of Object.entries(parsed.data)) {
          // A token set while loading is newer than the stored one.
          if (tokens.has(key)) continue;
          tokens.set(key, value.token);
          if (value.device) deviceKeys.add(key);
        }
      }
    } catch {
      // Unreadable storage: connect with the password and store fresh tokens.
    } finally {
      loaded = true;
    }
  })();

  return {
    ready,
    storeFor: ({ serverId, connectionId }) => {
      const key = keyFor(serverId, connectionId);
      return {
        get: () => tokens.get(key) ?? null,
        set: (token, info) => {
          if (token === (tokens.get(key) ?? null)) return;
          if (token) tokens.set(key, token);
          else tokens.delete(key);
          if (token && info?.device) deviceKeys.add(key);
          else deviceKeys.delete(key);
          const written = loaded ? persist() : ready.then(persist);
          if (token && info?.device) notifyDevice(key, written);
        },
      };
    },
    forgetServer: (serverId) => {
      let changed = false;
      for (const key of tokens.keys()) {
        const [keyServerId] = JSON.parse(key) as [string, string];
        if (keyServerId === serverId) {
          tokens.delete(key);
          deviceKeys.delete(key);
          changed = true;
        }
      }
      if (changed) void persist();
    },
    onDeviceToken: (listener) => {
      deviceListeners.add(listener);
      return () => {
        deviceListeners.delete(listener);
      };
    },
  };
}

let defaultRegistry: SessionTokenRegistry | null = null;

export function getSessionTokenRegistry(): SessionTokenRegistry {
  defaultRegistry ??= createSessionTokenRegistry(AsyncStorage);
  return defaultRegistry;
}
