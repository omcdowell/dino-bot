// Mac e2e helper: the phone's onboarding calls (bots plugin RPCs over the paired daemon), made with
// the daemon's own client, as the app makes them after pairing:
//   signin.options        the Claude row: last, EXTRA USAGE badge, confirm sheet
//   signin.start (Claude) without the confirm -> refused; confirmed -> Anthropic's real URL; cancel
//   setup.models          pi's live list for the signed-in providers (+ efforts)
//   setup.apply           the chosen models for bots, compaction and herdr workers
//   node phone-steps.mjs <HOME> <host:port> <provider> <model>      (PASEO_PASSWORD in the env)
const [H, host, provider, model] = process.argv.slice(2);
const { connectToDaemon } = await import(`${H}/.dinobot/app/daemon/dist/utils/client.js`);
const client = await connectToDaemon({ target: { kind: "endpoint", host }, timeout: 30_000 });
const rpc = (method, input = {}) => client.invokePluginRpc("bots", method, input);
const say = (s) => console.log(`PHONE ${s}`);
try {
  const opts = await rpc("signin.options");
  say(`signin.options available=${opts.available} rows=${opts.options.map((o) => o.label).join(" | ")}`);
  const claude = opts.options.find((o) => o.provider === "anthropic" && o.confirm);
  const last = opts.options[opts.options.length - 1];
  say(`claude row: "${claude?.label}" badge=${claude?.badge} last=${last === claude} confirm="${claude?.confirm?.title}"`);
  let refused = null;
  try {
    const r = await rpc("signin.start", { optionId: claude.id, confirmed: false });
    refused = r?.error ?? (r?.state === "error" ? "error" : null);
    if (r?.sessionId) await rpc("signin.cancel", { sessionId: r.sessionId });
  } catch (e) {
    refused = e.message;
  }
  say(`claude without confirm: ${refused ? `refused (${String(refused).slice(0, 120)})` : "NOT refused"}`);
  const s = await rpc("signin.start", { optionId: claude.id, confirmed: true });
  let st = s;
  for (let i = 0; i < 20 && !st.url; i++) {
    await new Promise((r) => setTimeout(r, 500));
    st = await rpc("signin.status", { sessionId: s.sessionId });
  }
  say(`claude confirmed: state=${st.state} url=${st.url ? st.url.split("?")[0] : "none"} prompt=${st.prompt?.kind ?? "-"}`);
  await rpc("signin.cancel", { sessionId: s.sessionId });
  const m = await rpc("setup.models", { refresh: false });
  const mine = m.models.filter((x) => x.provider === provider);
  say(`setup.models providers=${m.providers.join(",")} ${provider} models=${mine.length} efforts(${model})=${mine.find((x) => x.id === model)?.levels.join("/") ?? "?"}`);
  const pick = { provider, model, thinking: mine.find((x) => x.id === model)?.levels.includes("low") ? "low" : null };
  const a = await rpc("setup.apply", { models: { bots: pick, compaction: pick, workers: pick } });
  say(`setup.apply ok=${a.ok} applied=${a.applied.join(", ")}`);
} catch (e) {
  say(`ERROR ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit();
