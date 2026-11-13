import { getHostRuntimeStore } from "@/runtime/host-runtime";

/** The host's client; right after opening the app it may still be connecting, so wait a little. */
export async function botsHostClient(serverId: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const client = getHostRuntimeStore().getClient(serverId);
    if (client) return client;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** One bots-plugin RPC on `serverId`. */
export async function botsRpc<T>(serverId: string, method: string, input: unknown): Promise<T> {
  const client = await botsHostClient(serverId);
  if (!client) throw new Error("Not connected to your computer.");
  return (await client.invokePluginRpc("bots", method, input)) as T;
}
