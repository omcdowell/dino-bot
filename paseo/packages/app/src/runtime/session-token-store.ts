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
const StoredSchema = z.record(z.string(), z.object({ token: z.string().min(1).max(256) }));

export interface SessionTokenPersistence {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface SessionTokenRegistry {
  storeFor(input: { serverId: string; connectionId: string }): DaemonSessionTokenStore;
  forgetServer(serverId: string): void;
  /** Resolves once stored tokens are loaded (connects before then use the password). */
  ready: Promise<void>;
}

function keyFor(serverId: string, connectionId: string): string {
  return JSON.stringify([serverId, connectionId]);
}

export function createSessionTokenRegistry(storage: SessionTokenPersistence): SessionTokenRegistry {
  const tokens = new Map<string, string>();
  let writeChain: Promise<void> = Promise.resolve();
  let loaded = false;

  const persist = () => {
    const snapshot: Record<string, { token: string }> = {};
    for (const [key, token] of tokens) snapshot[key] = { token };
    writeChain = writeChain
      .then(() => storage.setItem(STORAGE_KEY, JSON.stringify(snapshot)))
      .catch(() => undefined);
  };

  const ready = (async () => {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) {
        for (const [key, value] of Object.entries(parsed.data)) {
          // A token set while loading is newer than the stored one.
          if (!tokens.has(key)) tokens.set(key, value.token);
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
        set: (token) => {
          if (token === (tokens.get(key) ?? null)) return;
          if (token) tokens.set(key, token);
          else tokens.delete(key);
          if (loaded) persist();
          else void ready.then(persist);
        },
      };
    },
    forgetServer: (serverId) => {
      let changed = false;
      for (const key of tokens.keys()) {
        const [keyServerId] = JSON.parse(key) as [string, string];
        if (keyServerId === serverId) {
          tokens.delete(key);
          changed = true;
        }
      }
      if (changed) persist();
    },
  };
}

let defaultRegistry: SessionTokenRegistry | null = null;

export function getSessionTokenRegistry(): SessionTokenRegistry {
  defaultRegistry ??= createSessionTokenRegistry(AsyncStorage);
  return defaultRegistry;
}
