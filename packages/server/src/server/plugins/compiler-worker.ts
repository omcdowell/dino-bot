import { fileURLToPath } from "node:url";
import { compilePlugin } from "./compiler.js";
import type { CompilerRequest, CompilerResponse } from "./isolated-compiler.js";

/**
 * Child process entry for isolated-compiler.ts: compiles plugin bundles on request. esbuild's
 * service process and the TypeScript compiler the import checks load live and die with it.
 */
function serve(): void {
  process.on("message", (message: CompilerRequest) => {
    void compilePlugin(message.entryPaths).then(
      (bundles) => reply({ id: message.id, ok: true, ...bundles }),
      (error: unknown) =>
        reply({
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });
  // The daemon closed the channel (idle, shutdown or crash): nothing is left to do.
  process.on("disconnect", () => process.exit(0));
}

function reply(response: CompilerResponse): void {
  process.send?.(response);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve();
