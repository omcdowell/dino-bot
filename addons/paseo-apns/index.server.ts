import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadSettings } from "./server/config.ts";
import { ApnsService } from "./server/service.ts";
import { liveActivitySyncRpc, registerRpc, revokeRpc } from "./shared/rpc.ts";

export default function contribute(server: PluginServerContext) {
  const settings = loadSettings();
  const service = new ApnsService({ settings });

  server.handle(registerRpc, (input) =>
    service.register({ token: input.token.toLowerCase(), environment: input.environment, topic: input.topic, name: input.name ?? null }),
  );
  server.handle(revokeRpc, ({ token }) => service.revoke(token.toLowerCase()));
  server.handle(liveActivitySyncRpc, (input) => service.liveActivitySync(input));

  service.start().then(
    (port) =>
      console.log(
        `[paseo-apns] listening on 127.0.0.1:${port}; ${settings.mode === "local" ? "local mode (no remote push)" : settings.apns ? `topic ${settings.apns.topic}` : `not configured (${settings.configError})`}`,
      ),
    (error) => {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      console.error(`[paseo-apns] endpoint did not start (${code})`);
      service.log.append("error", { code: "endpoint_start", detail: String(code) });
    },
  );

  return () => service.stop();
}
