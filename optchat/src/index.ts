import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createCompressor } from './compactor.ts';
import {
  atomicWrite,
  createProfile,
  instructions,
  lastProfile,
  listProfiles,
  PROFILE_FILE,
  ProfileBusyError,
  requestedProfile,
  saveConfig,
} from './profiles.ts';
import { cachePayload, record } from './cache.ts';
import { searchProviders, slimWebTools } from './web-tools.ts';
import { memoryTools } from './tools.ts';
import { exportBrowser } from './browser.ts';
import { discardImport, pendingImport, prepareImport, runImport } from './import/job.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { backgroundState, finishBackground } from './import/auto.ts';
import { importModelFor } from './model-defaults.ts';
import { showUsage } from './usage-page.ts';
import { showSettings } from './settings-page.ts';
import { errorText, SessionController } from './controller.ts';
import room from './room/index.ts';

const binding = 'optchat.profile';
/** How long a headless Pi waits for a busy profile at start. A launcher's probe Pi (Paseo's provider catalog) holds it for a few seconds. */
const busyWaitMs = () => Number(process.env.OPTCHAT_BUSY_WAIT_MS ?? 10_000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Paseo starts every agent session with PASEO_AGENT_ID set. Its provider-catalog probe (`fetchCatalog`) starts the same
 * `pi -e pi-optchat --mode rpc` in the workspace folder without it, asks for the models and exits without any input.
 * An RPC Pi without that id therefore defers its profile to the first input, so a probe never takes the lock.
 */
const launcherAgent = () => Boolean(process.env.PASEO_AGENT_ID?.trim());
const ACTIONS = ['profile', 'settings', 'usage', 'instructions', 'browse', 'import'] as const;

export default function optchat(pi: ExtensionAPI) {
  // A group chat room seat (OPTCHAT_ROOM, set by the bots plugin) opens no profile: see src/room/index.ts.
  if (process.env.OPTCHAT_ROOM) return room(pi);
  const session = new SessionController(pi);
  let stopping = false;
  /** A profile this session asked for but found busy. The next input tries it again, so the session never stays without memory. */
  let wanted: { name: string; bind: boolean; deferred?: boolean } | undefined;

  /** Opens `name`, waiting up to `waitMs` while another Pi holds it. */
  const openWhenFree = async (name: string, ctx: ExtensionContext, waitMs: number) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return await session.open(name, ctx);
      } catch (error) {
        if (!(error instanceof ProfileBusyError) || Date.now() >= deadline || stopping) throw error;
      }
      await sleep(250);
    }
  };

  /** Retries a profile that was busy when the session started; while it is still busy, the fault names the holder. */
  const reopenWanted = async (ctx: ExtensionContext) => {
    if (session.active || !wanted) return;
    const { name, bind, deferred } = wanted;
    wanted.deferred = false;
    try {
      // A deferred profile has not been tried yet, so it waits out a short-lived holder like a start does.
      await openWhenFree(name, ctx, deferred ? busyWaitMs() : 0);
    } catch (error) {
      await session.close().catch(() => {});
      session.fault = errorText(error);
      if (!(error instanceof ProfileBusyError)) wanted = undefined;
      return;
    }
    wanted = undefined;
    if (bind) pi.appendEntry(binding, { name });
  };
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;

  pi.registerFlag('optchat-profile', {
    description: 'OptChat profile. Falls back to OPTCHAT_PROFILE, then a .optchat-profile file in the working directory.',
    type: 'string',
  });

  const stop = async () => {
    stopping = true;
    importController?.abort();
    await importTask?.catch(() => {});
    await session.close();
  };

  const chooseProfile = async (ctx: ExtensionContext): Promise<string | undefined> => {
    if (!ctx.hasUI) return undefined;
    const names = listProfiles();
    const last = lastProfile();
    if (last) names.sort((a, b) => Number(b === last) - Number(a === last));
    const selected = await ctx.ui.select('OptChat profile', [...names, '+ Create profile']);
    if (selected !== '+ Create profile') return selected;
    const name = (await ctx.ui.input('New profile name', 'work or personal'))?.trim();
    if (!name) return undefined;
    createProfile(name);
    return name;
  };

  pi.on('session_start', async (_event, ctx) => {
    stopping = false;
    wanted = undefined;
    const entries = ctx.sessionManager.getEntries();
    const saved = entries.findLast(e => e.type === 'custom' && e.customType === binding);
    const boundName = saved?.type === 'custom' && record(saved.data) && typeof saved.data.name === 'string' ? saved.data.name : undefined;
    // A session with conversation in it belongs to its profile. One that is only bound (a fresh `/optchat profile` session) may still pick another.
    const settled = boundName !== undefined && entries.some(e => e.type === 'message' || e.type === 'custom_message');
    try {
      const flag = requestedProfile(pi.getFlag('optchat-profile'), ctx.cwd);
      if (boundName && typeof flag === 'string' && flag !== boundName)
        throw new Error(`Session belongs to ${boundName}; cannot resume it as ${flag}.`);
      // Only an interactive TUI can show the picker; in RPC/print/JSON it would block the launcher (Paseo probes providers headlessly).
      let name = boundName ?? flag ?? (ctx.mode === 'tui' ? await chooseProfile(ctx) : undefined);
      if (!name && ctx.mode !== 'tui')
        ctx.ui.notify(
          `OptChat is off: no profile requested. Pass --optchat-profile, set OPTCHAT_PROFILE, or add a ${PROFILE_FILE} file to ${ctx.cwd}.`,
          'warning',
        );
      // An RPC start that is not a launcher's agent session (e.g. Paseo's catalog probe) opens the profile on its first input.
      if (name && ctx.mode === 'rpc' && !launcherAgent()) {
        wanted = { name, bind: name !== boundName, deferred: true };
        session.status(ctx);
        return;
      }
      for (;;) {
        if (!name) {
          session.status(ctx);
          return;
        }
        try {
          // Headless Pis have no one to ask, so they wait out a short-lived holder such as a launcher's probe.
          await openWhenFree(name, ctx, ctx.mode === 'tui' ? 0 : busyWaitMs());
          break;
        } catch (error) {
          if (error instanceof ProfileBusyError && (ctx.mode !== 'tui' || settled)) wanted = { name, bind: name !== boundName };
          // A resumed conversation already belongs to its profile, so only a fresh session may pick another.
          if (!(error instanceof ProfileBusyError) || ctx.mode !== 'tui' || settled) throw error;
          const choice = await ctx.ui.select(`${name} is open in another window\n${error.owner}`, ['Pick another profile']);
          if (!choice) throw error;
          name = await chooseProfile(ctx);
        }
      }
      if (name !== boundName) pi.appendEntry(binding, { name });
    } catch (error) {
      await session.close().catch(() => {});
      session.fault = errorText(error);
      ctx.ui.notify(session.fault, 'error');
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => session.reapplyTitle(), ms).unref();
  });
  pi.on('session_info_changed', () => session.reapplyTitle()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', async () => {
    wanted = undefined;
    await stop();
  });
  pi.on('session_before_switch', () => (session.importing ? { cancel: true } : undefined));
  pi.on('session_before_fork', () => (session.importing ? { cancel: true } : undefined));
  pi.on('input', async (event, ctx) => {
    await reopenWanted(ctx);
    return { action: session.input(event.text, event.source, ctx) };
  });
  pi.on('before_agent_start', (event, ctx) => session.beforeAgentStart(event, ctx));
  pi.on('agent_start', (_event, ctx) => session.agentStart(ctx));
  pi.on('message_end', (event, ctx) => {
    const message = session.messageEnd(event.message, ctx);
    return message ? { message } : undefined;
  });
  pi.on('context_with_system', (event, ctx) => session.context(event, ctx));
  // Read once: the providers web_search and source_check declare (see web-tools.ts).
  const providers = searchProviders();
  pi.on('before_provider_request', (event, ctx) => {
    const slim = slimWebTools(event.payload, providers);
    if (ctx.model?.api !== 'anthropic-messages') return slim;
    const payload = cachePayload(slim);
    session.turnPrefix.capture(ctx.model.provider, payload, ctx.model.id);
    return payload;
  });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('session_before_compact', (_event, ctx) => {
    ctx.ui.notify(
      'OptChat manages history between turns. Pi compaction is disabled; an exceptionally long single run may require stopping and continuing in a new turn.',
      'info',
    );
    return { cancel: true };
  });
  pi.on('turn_end', (_event, ctx) => session.collectUsage(ctx));
  pi.on('agent_settled', (_event, ctx) => session.agentSettled(ctx));

  const [zoom, search, date] = memoryTools(() => session.required().memory);
  pi.registerTool(zoom);
  pi.registerTool(search);
  pi.registerTool(date);

  const importHistory = async (ctx: ExtensionCommandContext) => {
    const a = session.required();
    if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
    if (!ctx.isIdle()) throw new Error('Finish active work before importing.');
    session.importing = true;
    importController = new AbortController();
    let closed = false;
    session.status(ctx);
    const signal = importController.signal;
    // The import has its own, cheaper compactor (Haiku on Anthropic): it makes ~9 calls per imported message.
    // A model this pi does not have (e.g. a provider plugin that lists other ids) falls back to the ongoing compactor.
    const preferred = importModelFor(a.config);
    const importModel = ctx.modelRegistry.find(preferred.provider, preferred.model) ? preferred : a.config.compactor;
    importTask = (async () => {
      const background = backgroundState(a.dir);
      if (background?.status === 'ready') {
        if (
          !(await ctx.ui.confirm(
            'Finish background import?',
            'Old chats are summarised. Switch this profile to the memory with them now?',
            { signal },
          ))
        )
          return;
        await session.quiesce();
        await a.memory.close();
        closed = true;
        const done = finishBackground(a.dir);
        ctx.ui.notify(`Imported ${done.added} messages into ${a.name}.`, 'info');
        return;
      }
      let job = pendingImport(a.dir);
      if (job) {
        const selected = await ctx.ui.select(
          `Paused ${job.mode} import · ${job.added} new messages`,
          ['Resume import', 'Discard staged import', 'Cancel'],
          { signal },
        );
        if (selected === 'Discard staged import') {
          if (await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) {
            signal.throwIfAborted();
            discardImport(a.dir);
          }
          return;
        }
        if (selected !== 'Resume import') return;
      } else {
        const plan = await chooseImport(
          ctx,
          a.name,
          a.memory,
          `${importModel.provider}/${importModel.model} (${importModel.thinking})`,
          signal,
        );
        if (!plan) return;
        signal.throwIfAborted();
        await session.quiesce();
        await a.memory.close();
        closed = true;
        signal.throwIfAborted();
        job = prepareImport(a.dir, a.memory, plan.entries, plan.mode);
        if (!job) return;
      }
      if (!closed) {
        await a.memory.close();
        closed = true;
      }
      const compress = createCompressor(
        ctx.modelRegistry,
        () => importModel,
        message => a.usage.compression(message, 'import', ctx.sessionManager.getSessionId()),
        () => a.config.summaryAcceptBytes,
        session.turnPrefix,
      );
      const completed = await showProgress(ctx, job, (signal, progress) => runImport(a.dir, compress, signal, progress), signal);
      ctx.ui.notify(
        completed
          ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.`
          : 'Import paused. Use /optchat import to resume. Other profiles remain available.',
        'info',
      );
    })();
    let failure: unknown;
    try {
      await importTask;
    } catch (error) {
      failure = error;
    } finally {
      session.importing = false;
      importTask = undefined;
      importController = undefined;
      ctx.ui.setWidget('optchat-import', undefined);
    }
    // Memory was closed for the import; a fresh session reopens the profile on the new generation.
    if (closed && !stopping) await ctx.newSession({ setup: async manager => void manager.appendCustomEntry(binding, { name: a.name }) });
    else session.status(ctx);
    if (failure) throw failure;
  };

  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (session.importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = session.active;
      const info = a
        ? `${a.name} · ${a.memory.root.length} messages · ${a.memory.pending} pending\nCompactor: ${a.config.compactor.model} (${a.config.compactor.thinking})\n${a.memory.lastError ?? ''}`
        : 'No active profile';
      action = (await ctx.ui.select(`OptChat\n${info}`, [...ACTIONS])) ?? '';
    }
    switch (action) {
      case '':
        return;
      case 'import':
        return importHistory(ctx);
      case 'profile': {
        if (!ctx.isIdle()) throw new Error('Finish or stop active work before switching profiles.');
        const selected = await chooseProfile(ctx);
        if (!selected || selected === session.active?.name) return;
        await ctx.newSession({ setup: async manager => void manager.appendCustomEntry(binding, { name: selected }) });
        return;
      }
      // `model` is kept as a shortcut; models are chosen on the settings page.
      case 'model':
      case 'settings': {
        const a = session.required();
        if (ctx.mode !== 'tui')
          throw new Error('/optchat settings requires interactive Pi. Edit config.json in the profile directory instead.');
        const models = ctx.modelRegistry
          .getAvailable()
          .map(m => ({ name: `${m.provider}/${m.id}`, thinking: getSupportedThinkingLevels(m) }))
          .sort((x, y) => x.name.localeCompare(y.name));
        return showSettings(ctx, { profile: a.name, config: a.config, models, save: config => saveConfig(a.dir, config) });
      }
      case 'usage': {
        const a = session.required();
        if (ctx.mode !== 'tui') throw new Error('/optchat usage requires interactive Pi.');
        return showUsage(ctx, {
          profile: a.name,
          session: ctx.sessionManager.getSessionId(),
          usage: a.usage,
          refreshUsage: () => session.collectUsage(ctx),
        });
      }
      case 'instructions': {
        const a = session.required();
        const edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, instructions(a.dir));
        if (edited !== undefined) {
          atomicWrite(join(a.dir, 'AGENTS.md'), edited);
          ctx.ui.notify('Saved. Applies to the next turn.', 'info');
        }
        return;
      }
      case 'browse': {
        const a = session.required();
        const file = exportBrowser(a.memory, a.name, a.dir);
        if (ctx.hasUI)
          execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => error && ctx.ui.notify(`Open ${file}`, 'info'));
        ctx.ui.notify(file, 'info');
        return;
      }
      default:
        throw new Error(`Use /optchat [${ACTIONS.join('|')}].`);
    }
  };
  pi.registerCommand('optchat', {
    description: 'OptChat profiles, settings, usage, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ACTIONS.filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        await command(args, ctx);
      } catch (error) {
        ctx.ui.notify(errorText(error), 'error');
      }
    },
  });
}
