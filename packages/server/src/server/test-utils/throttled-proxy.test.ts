import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { ThrottledProxy } from "./throttled-proxy.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

async function echoServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.on("error", () => undefined);
    cleanup.push(() => void socket.destroy());
  });
}

function echo(socket: net.Socket, text: string, timeoutMs: number): Promise<string | null> {
  const reply = new Promise<string>((resolve) => {
    socket.once("data", (data) => resolve(String(data)));
  });
  socket.write(text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([reply, timeout]).finally(() => clearTimeout(timer));
}

it("strands open connections like a laptop waking up: no data, no close, new ones work", async () => {
  const proxy = new ThrottledProxy({ host: "127.0.0.1", port: await echoServer() });
  const port = await proxy.listen();
  cleanup.push(() => proxy.close());
  const old = await connect(port);
  expect(await echo(old, "before", 1000)).toBe("before");

  let closed = false;
  old.on("close", () => (closed = true));
  proxy.strandAll();

  expect(await echo(old, "after", 300)).toBeNull();
  expect(closed).toBe(false);
  const fresh = await connect(port);
  expect(await echo(fresh, "fresh", 1000)).toBe("fresh");
});
