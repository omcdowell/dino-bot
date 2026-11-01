import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BotsService, setDefaultChatModel, type BotsPaseo } from "./server/bots";
import { DmsService, type DmsPaseo } from "./server/dms";
import { WorkersService } from "./server/workers";
import { botDmSender } from "./server/bot-dm-send";
import { Extensions } from "./server/extensions";
import { HerdrInstance } from "./server/herdr-instance";
import { botEnv, loadSettings, readSettingsAt, writeRoomFullTools } from "./server/settings";
import { isUserParty, setUserName } from "./shared/party";
import { OPTCHAT_PROVIDER } from "./shared/rpc";
import { PushSlotNotifier, SLOT_SENDER, TICK_MS } from "./server/push-slot-notify";
import { httpPush } from "./server/apns-push";
import { dmsReplyRpc, dmsSummaryRpc, dmsThreadRpc, dmsThreadsRpc } from "./shared/dm-rpc";
import { DmTurnsService, TIMELINE_TAIL } from "./server/dm-turns";
import { botsListRpc, botsNewChatRpc, botsOpenRpc, botsQuietRpc } from "./shared/rpc";
import { botsWorkersRpc } from "./shared/workers-rpc";
import { botsAvatarRpc, botsPreviewsRpc } from "./shared/home-rpc";
import { dmPreview, latestPreview, newestTime, PreviewsService } from "./server/previews";
import { AvatarsService, avatarAnswer, withAvatarHashes } from "./server/avatars";
import { avatarJsonHash, packGzip } from "./server/avatar-store";
import { AVATAR_PACK_JSON, AVATAR_PACK_VERSION } from "./shared/avatar";
import { botsAvatarJsonRpc, botsAvatarPackRpc, botsAvatarPackVersionRpc, botsAvatarSaveRpc } from "./shared/avatar-rpc";
import { quotaRpc } from "./shared/quota-rpc";
import { INTRO_PROMPT } from "./shared/templates";
import { botsRevRpc, type PushKind } from "./shared/push-rpc";
import { BotsPush, type Emit } from "./server/push";
import { BusyFeed, WeeklyGate } from "./server/live-activity";
import { RoomHandover } from "./server/rooms/handover";
import { GroupsFile } from "./server/rooms/groups";
import { roomsRoot } from "./server/rooms/ledger";
import { CHECK_MS as ROOMS_CHECK_MS, procMemAvailable, RoomSessions, type RoomsPaseo } from "./server/rooms/sessions";
import { RoomsService } from "./server/rooms/service";
import { BotFiles, HomeStateFile } from "./server/manage";
import { createGroup, renameGroup } from "./server/rooms/groups";
import { groupIdFor } from "./shared/manage";
import {
  botsAgentsMdRpc,
  botsCompactorRpc,
  botsCreateRpc,
  botsDeleteRpc,
  botsSetCompactorRpc,
  botsUpdateRpc,
  homeArchiveRpc,
  homePinRpc,
  homeStateRpc,
  roomsCreateRpc,
  roomsRenameRpc,
} from "./shared/manage-rpc";
import { Onboarding } from "./server/onboarding";
import {
  setupApplyRpc,
  setupImportScanRpc,
  setupModelsRpc,
  signinCancelRpc,
  signinOptionsRpc,
  signinStartRpc,
  signinStatusRpc,
  signinSubmitRpc,
} from "./shared/onboarding-rpc";
import {
  ROOMS_EVENT,
  roomsBotPostRpc,
  roomsListRpc,
  roomsPostRpc,
  roomsSetMembersRpc,
  roomsSettingsRpc,
  roomsSettingsSetRpc,
  roomsThreadRpc,
} from "./shared/rooms/rpc";

export default function contribute(server: PluginServerContext) {
  const root = process.env.PASEO_BOTS_ROOT ?? join(homedir(), "bots");
  // Host settings (<root>/.settings.json): user name and aliases, escalation bot, default model,
  // herdr instance, add-ons. Read once; a plugin reload picks up changes.
  const settings = loadSettings(process.env);
  setUserName(settings.user.name);
  setDefaultChatModel(
    settings.models.bots ? `${settings.models.bots.provider}/${settings.models.bots.model}` : settings.defaultModel,
    settings.models.bots?.thinking ?? null,
  );
  // Private or optional add-ons (usage source, stall watcher, …): none in the public build.
  const extensions = new Extensions({ settings, server });
  extensions.load();
  // Workers run in the plugin's own herdr instance unless the settings pick the user's server.
  const herdr = HerdrInstance.fromSettings(settings);
  void herdr.ready();
  const service = new BotsService(root);
  // PaseoApi is structurally wider than the slices the services need.
  const sdk = (paseo: unknown) => paseo as BotsPaseo;

  // Bots-home data is pushed when it changes on hosts that can (server.emit, Paseo plugin events);
  // apps then stop polling it. The plugin process has one Paseo API: the watch loop borrows the
  // one the last call came with. Older hosts have no emit: the apps keep polling.
  const emit = (server as { emit?: Emit }).emit?.bind(server);
  let lastApi: BotsPaseo | null = null;
  const push = new BotsPush(emit, {
    previews: () => withApi(previewsFor),
    workers: () => withApi(workersFor),
    quiet: () => withApi(quietFor),
  });
  const withApi = <T>(compute: (api: BotsPaseo) => Promise<T>): Promise<T> => {
    if (!lastApi) return Promise.reject(new Error("no Paseo API yet"));
    return compute(lastApi);
  };
  const answer = async <T>(kind: PushKind, paseo: unknown, compute: (api: BotsPaseo) => Promise<T>) => {
    lastApi = sdk(paseo);
    push.touch();
    busyFeed.touch(lastApi);
    const result = await compute(lastApi);
    push.publish(kind, result);
    return result;
  };
  server.handle(botsRevRpc, (_input, { paseo }) => {
    lastApi = sdk(paseo);
    push.touch();
    busyFeed.touch(lastApi);
    return { push: push.pushes, revs: push.revisions() };
  });
  const avatars = new AvatarsService();
  server.handle(botsListRpc, async (_input, { paseo }) => ({
    bots: await withAvatarHashes(await service.list(sdk(paseo)), avatars),
    avatarPackVersion: AVATAR_PACK_VERSION,
  }));
  // Keep-live labels (chat-prefetch): backfilled on the first call after start, then at most once
  // a minute from the home poll and right after a chat changes.
  let keepLiveAt = 0;
  const syncKeepLive = (paseo: unknown, force = false) => {
    if (!force && Date.now() - keepLiveAt < 60_000) return;
    keepLiveAt = Date.now();
    void service.syncKeepLive(sdk(paseo)).catch(() => {});
  };
  server.handle(botsOpenRpc, async ({ botId }, { paseo }) => {
    const result = await service.open(botId, sdk(paseo));
    syncKeepLive(paseo, result.created);
    return result;
  });
  server.handle(botsNewChatRpc, async ({ botId }, { paseo }) => {
    const result = await service.newChat(botId, sdk(paseo));
    syncKeepLive(paseo, true);
    return result;
  });

  // Herdr workers each bot is waiting on: launch registry (bot-worker add) + `herdr agent list`.
  const workers = new WorkersService({ env: herdr.env });
  const workersFor = async (api: BotsPaseo) => {
    const { bots, ownerOf } = await service.listWithOwners(api);
    const result = await workers.byBot(bots, ownerOf);
    // Add-ons see each read (e.g. a stall watcher that DMs a bot about a stalled worker).
    extensions.workers(result.bots);
    return result;
  };
  server.handle(botsWorkersRpc, (_input, { paseo }) => answer("workers", paseo, workersFor));

  // iPhone Live Activity of busy bots (server/live-activity.ts), sent by the paseo-apns add-on. Runs
  // with no app connected: a turn start (daemon lifecycle hook) brings the Paseo API and a check.
  // Workers are read without the add-ons' listeners, so no app-less stall DMs start from here.
  // Own WorkersService: herdr read on every check, not through the bots home's 4 s cache.
  const busyWorkers = new WorkersService({ cacheMs: 0, env: herdr.env });
  // Stalled bots drop off when the usage source's weekly window is used up (read only while one is
  // stalled, 60 s cache). Only with an add-on that reads usage; otherwise they always show.
  const weekly = new WeeklyGate(() => extensions.report());
  const busyFeed = new BusyFeed({
    weeklyFull: extensions.hasQuota() ? () => weekly.full() : undefined,
    read: async (api) => {
      const { bots, chats, ownerOf } = await service.snapshot(api);
      const result = await busyWorkers.byBot(bots, ownerOf);
      return { bots, chats, workers: result.bots };
    },
    onError: () => {},
  });
  const on = (server as { on?: PluginServerContext["on"] }).on?.bind(server);
  on?.("agent.turn_started", (event, { paseo }) => busyFeed.turnStarted(sdk(paseo), event.agent.id));

  // Rows: hide "New reply" when only bot DMs started the turns behind it (decision 2026-10-08).
  const dmTurns = new DmTurnsService();
  const quietFor = async (api: BotsPaseo) => {
    const chats = await service.chats(api);
    const agentIds = await dmTurns.quiet(chats, async (id) => {
      const timeline = api.agents.ref(id).timeline;
      if (!timeline) throw new Error("timeline not available");
      return timeline.refetch({ direction: "tail", limit: TIMELINE_TAIL, projection: "projected" });
    });
    return { agentIds };
  };
  server.handle(botsQuietRpc, (_input, { paseo }) => answer("quiet", paseo, quietFor));

  // DMs: reads ~/bots/<bot>/dm/*.jsonl (written by bot-dm); writes only the user's replies. A plain
  // read-only view: no read state, no unread counts (the DMs are not addressed to the user).
  const dms = new DmsService({
    root,
    openChat: (botId, paseo) => service.open(botId, sdk(paseo)),
  });
  server.handle(dmsSummaryRpc, async () => ({ bots: await dms.summary() }));
  server.handle(dmsThreadsRpc, ({ botId }) => dms.threads(botId));
  server.handle(dmsThreadRpc, ({ botId, threadId, messageId }) => dms.thread(botId, { threadId, messageId }));
  server.handle(dmsReplyRpc, ({ botId, threadId, text }, { paseo }) =>
    dms.reply(botId, threadId, text, paseo as unknown as DmsPaseo),
  );

  // Phone home (layout A): one-line previews (last reply or sent DM) and the latest turn's start.
  const previews = new PreviewsService();
  const previewsFor = async (api: BotsPaseo) => {
    syncKeepLive(api);
    const rows = await service.botChats(api);
    const names = new Map(rows.map(({ bot }) => [bot.id, bot.name]));
    const nameOf = (party: string) =>
      isUserParty(party)
        ? "You"
        : party.startsWith("worker:schedule.")
          ? `schedule ${party.slice("worker:schedule.".length)}`
          : party.startsWith("worker:")
            ? `worker ${party.slice(7)}`
            : (names.get(party) ?? party);
    const out = await Promise.all(
      rows.map(async ({ bot, chat }) => {
        const fromChat = chat
          ? await previews.forChat(chat, async (id, limit) => {
              const timeline = api.agents.ref(id).timeline;
              if (!timeline) throw new Error("timeline not available");
              return timeline.refetch({ direction: "tail", limit, projection: "projected" });
            })
          : { preview: null, turnStartedAt: null, messageAt: null };
        let dm = null;
        let dmAt: string | null = null;
        try {
          const sent = await dms.latestOutgoing(bot.id);
          dm = sent ? dmPreview(sent, nameOf) : null;
          dmAt = await dms.latestAt(bot.id);
        } catch {
          dm = null;
        }
        const preview = latestPreview(fromChat.preview, dm);
        return {
          botId: bot.id,
          preview,
          turnStartedAt: fromChat.turnStartedAt,
          activityAt: newestTime(fromChat.messageAt, dmAt, preview?.ts),
        };
      }),
    );
    previews.retain(rows.flatMap(({ chat }) => (chat ? [chat.id] : [])));
    return { bots: out };
  };
  server.handle(botsPreviewsRpc, (_input, { paseo }) => answer("previews", paseo, previewsFor));

  // A designed avatar (avatar.json) sends the render of the size asked for; a plain avatar.png as before.
  // format "json" (AV4): the avatar.json itself (~300 B) when the phone can draw it; else the PNG as asked.
  server.handle(botsAvatarRpc, async ({ botId, size, format }, { paseo }) => {
    const bot = (await service.list(sdk(paseo))).find((candidate) => candidate.id === botId);
    return avatarAnswer(avatars, bot, { size, format });
  });
  // Rate-limit card's "Resets …": the add-on's usage source, if any (none in the public build).
  server.handle(quotaRpc, () => extensions.quota());

  // Onboarding on the phone (DinoBot): sign-in, models, optional import. pi does the work.
  const onboarding = new Onboarding(settings, root);
  server.handle(signinOptionsRpc, () => onboarding.options());
  server.handle(signinStartRpc, async (input) => (await onboarding.need()).start(input) as never);
  server.handle(signinSubmitRpc, async (input) => (await onboarding.need()).submit(input) as never);
  server.handle(signinStatusRpc, async (input) => (await onboarding.need()).status(input) as never);
  server.handle(signinCancelRpc, async (input) => (await onboarding.need()).cancel(input) as never);
  server.handle(setupModelsRpc, ({ refresh }) => onboarding.models(refresh) as never);
  server.handle(setupImportScanRpc, () => onboarding.importScan() as never);
  server.handle(setupApplyRpc, (input) => onboarding.apply(input as never));

  // A bot refused a push to the user (per-bot 10-min limit) gets one system DM when its slot
  // reopens. Pending notices live in push-slots.jsonl (written by bot-dm), so a reload loses none.
  const apns = httpPush(process.env);
  const slots = new PushSlotNotifier({
    send: botDmSender(process.env, { from: SLOT_SENDER, kind: "resume" }),
    nextSlot: async (bot) => {
      const st = await apns.status(bot);
      return st.reachable ? st.nextSlotAt : null;
    },
  });
  void slots.tick();
  const slotTimer = setInterval(() => void slots.tick(), TICK_MS);
  slotTimer.unref?.();

  // Group chat rooms (server/rooms): room sessions are separate Paseo agents in
  // ~/.local/state/bot-rooms/<group>/, labelled room=<group>, never bot=<bot>.
  const roomsSdk = (paseo: unknown) => paseo as RoomsPaseo;
  let roomsRev = 0;
  const roomSessions = new RoomSessions({ roomsRoot: roomsRoot(), botsRoot: root, memAvailable: () => procMemAvailable() });
  // U2: room talk reaches each member's main memory as blocks in <profile>/memory/room-blocks/ (never the bot's lock).
  const handover = new RoomHandover({
    roomDir: (group) => roomSessions.dir(group),
    profileDir: (bot) => roomSessions.profileDir(bot),
    onError: (error) => console.warn(`[bots] room handover: ${error instanceof Error ? error.message : String(error)}`),
  });
  const groupsFile = new GroupsFile(root);
  const rooms = new RoomsService({
    groups: groupsFile,
    sessions: roomSessions,
    handover,
    bots: async (api) =>
      (await withAvatarHashes(await service.list(sdk(api)), avatars)).map((bot) => ({
        id: bot.id,
        name: bot.name,
        icon: bot.icon,
        avatarHash: bot.avatarHash ?? null,
      })),
    mainChat: async (api, botId) => {
      const row = (await service.botChats(sdk(api))).find(({ bot }) => bot.id === botId);
      return row?.chat ? { status: row.chat.status ?? null, lastActivityAt: row.chat.lastActivityAt ?? null } : null;
    },
    assignDeps: (api) => ({
      openChat: (botId) => service.open(botId, sdk(api)),
      send: (agentId, text, opts) => (api as unknown as DmsPaseo).agents.ref(agentId).send(text, opts),
    }),
    // bot-room post: the caller's agent must be a chat of a bot (room sessions are labelled room=, never bot=).
    ownerOf: async (api, agentId) => (await service.listWithOwners(sdk(api))).ownerOf(agentId),
    onChange: (groupId) => emit?.(ROOMS_EVENT, { rev: ++roomsRev, data: { groupId } }),
    onError: () => {},
  });
  server.handle(roomsListRpc, (_input, { paseo }) => rooms.list(roomsSdk(paseo)));
  server.handle(roomsThreadRpc, ({ groupId, before, limit }, { paseo }) => rooms.thread(roomsSdk(paseo), groupId, before, limit));
  server.handle(roomsPostRpc, ({ groupId, text, assign }, { paseo }) =>
    rooms.post(roomsSdk(paseo), groupId, text, { assign: assign === true }),
  );
  server.handle(roomsBotPostRpc, (input, { paseo }) => rooms.botPost(roomsSdk(paseo), input));
  // Group chat tools (settings `rooms.fullTools`): read fresh from the file, written keeping every other key.
  // pi-optchat reads the same file on each room turn, so no plugin reload or daemon restart is needed.
  server.handle(roomsSettingsRpc, () => ({ fullTools: readSettingsAt(root).rooms.fullTools }));
  server.handle(roomsSettingsSetRpc, ({ fullTools }) => {
    const out = writeRoomFullTools(root, fullTools);
    settings.rooms.fullTools = out.fullTools;
    return out;
  });
  server.handle(roomsSetMembersRpc, ({ groupId, members, leads }, { paseo }) =>
    rooms.setMembers(roomsSdk(paseo), groupId, members, leads),
  );
  // Bot management (build 31): pins and archive in ~/bots/.home.json; bot and group create/edit.
  // Archive only hides an item from the home and sidebar. Group routing is not touched.
  const homeState = new HomeStateFile(root);
  const botFiles = new BotFiles({ root });
  const featuredId = async (paseo: unknown) => (await service.list(sdk(paseo))).find((bot) => bot.featured)?.id ?? null;
  server.handle(homeStateRpc, async (_input, { paseo }) => homeState.read(await featuredId(paseo)));
  server.handle(homePinRpc, async ({ key, pinned }, { paseo }) => homeState.pin(await featuredId(paseo), key, pinned));
  server.handle(homeArchiveRpc, async ({ key, archived }, { paseo }) =>
    homeState.archive(await featuredId(paseo), key, archived),
  );
  server.handle(botsAgentsMdRpc, ({ botId }) => botFiles.agentsMd(botId));
  server.handle(botsCreateRpc, async ({ intro, ...input }, { paseo }) => {
    const created = await botFiles.create(input);
    if (!intro) return created;
    // The first chat starts now with the intro prompt; a failure here leaves a working bot.
    try {
      const { agentId } = await service.introduce(created.botId, sdk(paseo), INTRO_PROMPT);
      syncKeepLive(paseo, true);
      return { ...created, agentId };
    } catch {
      return created;
    }
  });
  server.handle(botsDeleteRpc, async ({ botId, confirmName }, { paseo }) => {
    const bot = (await service.list(sdk(paseo))).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    if (confirmName.trim() !== bot.name.trim()) throw new Error(`Type ${bot.name} to delete it.`);
    const groupsWithBot = groupsFile.list().filter((g) => g.members.includes(botId)).map((g) => g.name);
    if (groupsWithBot.length) throw new Error(`Remove ${bot.name} from ${groupsWithBot.join(", ")} first.`);
    const archivedChats = await service.archiveChats(botId, sdk(paseo));
    const { trash } = await botFiles.remove(botId);
    await homeState.forget(await featuredId(paseo), `bot:${botId}`);
    return { ok: true as const, trash, archivedChats };
  });
  // Compaction model (OptChat profile config.json `compactor`): the Edit sheet's model + thinking.
  server.handle(botsCompactorRpc, ({ botId }) => botFiles.compactor(botId));
  server.handle(botsSetCompactorRpc, ({ botId, compactor }) => botFiles.setCompactor(botId, compactor));
  server.handle(botsUpdateRpc, async ({ botId, name, agentsMd, avatar, avatarJson }) => {
    if (avatar && avatarJson) throw new Error("Send a picture or a designed avatar, not both.");
    // AGENTS.md first: it is the one write that can be refused (changed on the host).
    if (agentsMd) await botFiles.writeAgentsMd(botId, agentsMd.text, agentsMd.baseMtimeMs);
    if (name !== undefined) await botFiles.rename(botId, name);
    if (avatar) await botFiles.setAvatar(botId, avatar);
    if (avatarJson) {
      const saved = await botFiles.saveAvatarJson(botId, avatarJson);
      if (saved.reason === "stale") throw new Error(`The avatar changed on the host since (revision ${saved.revision}). Open Edit again.`);
      if (saved.reason === "invalid") throw new Error(`The avatar is not valid: ${saved.error}`);
      return { ok: true as const, avatarHash: saved.hash };
    }
    return { ok: true as const };
  });
  // Designed avatars (AV1): avatar.json is the source of truth; the host renders 64/128/512 and avatar.png.
  server.handle(botsAvatarSaveRpc, ({ botId, avatar }) => botFiles.saveAvatarJson(botId, avatar));
  server.handle(botsAvatarJsonRpc, async ({ botId }, { paseo }) => {
    const avatar = await botFiles.avatarJson(botId);
    if (!avatar) return { avatar: null, hash: null, live: false };
    const hash = avatarJsonHash(avatar);
    const bot = (await service.list(sdk(paseo))).find((candidate) => candidate.id === botId);
    const live = !!bot && (await avatars.hashForBot(bot)) === hash;
    return { avatar, hash, live };
  });
  server.handle(botsAvatarPackVersionRpc, () => ({ packVersion: AVATAR_PACK_VERSION }));
  // The options pack for an app that ships an older one (fetched once, in the background); the phone takes JSON.
  server.handle(botsAvatarPackRpc, ({ have, format }) => {
    const pack = packGzip();
    const send = have === undefined || have < pack.packVersion;
    if (format === "json") {
      return {
        packVersion: pack.packVersion,
        encoding: "json" as const,
        data: null,
        json: send ? AVATAR_PACK_JSON : null,
        bytes: pack.bytes,
        rawBytes: pack.rawBytes,
        sha256: pack.sha256,
      };
    }
    return {
      packVersion: pack.packVersion,
      encoding: "gzip-base64" as const,
      data: send ? pack.data : null,
      bytes: pack.bytes,
      rawBytes: pack.rawBytes,
      sha256: pack.sha256,
    };
  });
  server.handle(roomsCreateRpc, ({ name, members, leads }) => {
    const group = createGroup(groupsFile, root, { id: groupIdFor(name), name, members, leads });
    emit?.(ROOMS_EVENT, { rev: ++roomsRev, data: { groupId: group.id } });
    return { groupId: group.id };
  });
  server.handle(roomsRenameRpc, ({ groupId, name }) => {
    renameGroup(groupsFile, groupId, name);
    emit?.(ROOMS_EVENT, { rev: ++roomsRev, data: { groupId } });
    return { ok: true as const };
  });

  const before = (server as { before?: PluginServerContext["before"] }).before?.bind(server);
  // Paseo resumes agents (daemon restart) without the create-time env: give room agents theirs back.
  // OptChat agents (bots and room sessions) also get the settings (user name, escalation bot) and
  // the bots' herdr instance, so `herdr agent start` from a bot never lands in the user's herdr.
  before?.("agent.session_open", async ({ request }) => {
    const roomed = rooms.sessionOpen(request);
    if (request.provider !== OPTCHAT_PROVIDER) return roomed;
    const base = roomed ?? request;
    return { ...base, env: { ...base.env, ...botEnv(settings), ...(await herdr.agentEnv()) } };
  });
  on?.("agent.turn_started", (event) => {
    rooms.turnStarted(event.agent.id);
  });
  on?.("agent.turn_ended", async (event, { paseo }) => {
    await rooms.turnEnded(roomsSdk(paseo), event).catch(() => {});
  });
  const roomsTimer = setInterval(() => void rooms.tick().catch(() => {}), ROOMS_CHECK_MS);
  roomsTimer.unref?.();

  return () => {
    clearInterval(roomsTimer);
    clearInterval(slotTimer);
    push.stop();
    busyFeed.stop();
    extensions.stop();
  };
}
