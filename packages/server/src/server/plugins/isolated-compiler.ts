import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PluginEntryPaths {
  client: string | null;
  server: string | null;
}

export interface PluginBundles {
  clientBundle: string | null;
  serverBundle: string | null;
}

export interface CompilerRequest {
  id: number;
  entryPaths: PluginEntryPaths;
}

export type CompilerResponse =
  | ({ id: number; ok: true } & PluginBundles)
  | { id: number; ok: false; error: string };

export interface PluginCompiler {
  compile(entryPaths: PluginEntryPaths): Promise<PluginBundles>;
  close(): void;
}

/** How long the compiler process outlives its last compile; plugin loads come in bursts. */
const DEFAULT_IDLE_MS = 5_000;

function resolveWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts") ? "./compiler-worker.ts" : "./compiler-worker.js",
    import.meta.url,
  );
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

export function forkCompilerWorker(): ChildProcess {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

/**
 * Compiles plugins in a short-lived child process. In the daemon, esbuild's JS API keeps its
 * service process running for good after the first build, and the import checks load the
 * TypeScript compiler (~70 MB) into the heap, where a loaded module stays. Compiling happens at
 * plugin load only, so both now live in a child that exits once loads stop.
 */
export function createIsolatedPluginCompiler(
  options: { idleMs?: number; forkWorker?: () => ChildProcess } = {},
): PluginCompiler {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const forkWorker = options.forkWorker ?? forkCompilerWorker;
  let child: ChildProcess | null = null;
  let nextId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<
    number,
    { resolve: (bundles: PluginBundles) => void; reject: (error: Error) => void }
  >();

  function stopChild(target: ChildProcess): void {
    if (target.connected) target.disconnect();
    if (target.exitCode === null && target.signalCode === null) target.kill();
  }

  function failPending(error: Error): void {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.reject(error);
  }

  function scheduleIdleStop(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (pending.size > 0 || !child) return;
    const idleChild = child;
    // An idle compiler must not keep the process alive; the timer below ends it anyway.
    idleChild.unref();
    idleChild.channel?.unref();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (child !== idleChild || pending.size > 0) return;
      child = null;
      stopChild(idleChild);
    }, idleMs);
    idleTimer.unref();
  }

  function ensureChild(): ChildProcess {
    if (child) return child;
    const started = forkWorker();
    child = started;
    started.on("message", (response: CompilerResponse) => {
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (response.ok) {
        entry.resolve({ clientBundle: response.clientBundle, serverBundle: response.serverBundle });
      } else {
        entry.reject(new Error(response.error));
      }
      scheduleIdleStop();
    });
    const lost = (reason: string) => {
      if (child !== started) return;
      child = null;
      failPending(new Error(`Plugin compiler ${reason}`));
    };
    started.on("error", (error) => lost(`failed: ${error.message}`));
    started.on("exit", (code, signal) => lost(`exited (${signal ?? code})`));
    return started;
  }

  return {
    compile(entryPaths) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const id = ++nextId;
      const target = ensureChild();
      target.ref();
      target.channel?.ref();
      return new Promise<PluginBundles>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const request: CompilerRequest = { id, entryPaths };
        target.send(request, (error) => {
          if (!error || !pending.has(id)) return;
          pending.delete(id);
          reject(error);
          scheduleIdleStop();
        });
      });
    },
    close() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const current = child;
      child = null;
      failPending(new Error("Plugin compiler closed"));
      if (current) stopChild(current);
    },
  };
}
