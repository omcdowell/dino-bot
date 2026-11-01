// Electron main for the IndexedDB cache bench: node run.mjs drives it, one phase per process.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const [phase, arg] = process.argv.slice(-2);
app.setPath("userData", process.env.BENCH_USER_DATA);

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "index.html"));
  try {
    const call = phase === "fill" ? `bench.fill(${Number(arg)})` : "bench.measure()";
    const result = await win.webContents.executeJavaScript(call);
    process.stdout.write(`BENCH ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`BENCH_ERROR ${String(error)}\n`);
  }
  app.quit();
}

void main();
