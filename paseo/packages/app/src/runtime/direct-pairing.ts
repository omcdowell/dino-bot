import type { DirectTcpHostConnection } from "@/types/host-connection";

export interface DirectProbeResult<Client> {
  connection: DirectTcpHostConnection;
  client: Client;
  serverId: string;
  hostname: string | null;
}

/**
 * Happy eyeballs for a direct (v3) offer (rel-bench §3.3): try every endpoint at once, keep the
 * first that answers *as the offered server*, close the rest. A daemon on another endpoint that
 * answers with a different server id is ignored, so a stale LAN address cannot hijack the pairing.
 * Rejects with the last error when nothing answers.
 */
export async function raceDirectEndpoints<Client>(input: {
  serverId: string;
  connections: DirectTcpHostConnection[];
  probe: (
    connection: DirectTcpHostConnection,
  ) => Promise<{ client: Client; serverId: string; hostname: string | null }>;
  close: (client: Client) => Promise<void> | void;
}): Promise<DirectProbeResult<Client>> {
  if (input.connections.length === 0) throw new Error("The pairing code has no usable address.");
  let winner: DirectProbeResult<Client> | null = null;
  const attempts = input.connections.map(async (connection) => {
    const result = await input.probe(connection);
    if (result.serverId !== input.serverId) {
      await input.close(result.client);
      throw new Error(`${connection.endpoint} is a different server (${result.serverId}).`);
    }
    if (winner) {
      await input.close(result.client);
      throw new Error("slower endpoint");
    }
    winner = { connection, ...result };
    return winner;
  });
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    const last = errors[errors.length - 1];
    throw last instanceof Error ? last : new Error("Could not reach the computer at any address.");
  }
}
