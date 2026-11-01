// A bots host for the avatar cache tests and the byte measurement (scripts/avatar/cache-bytes.ts): 10 bots
// with designer avatars (avatar.json from the AV2 parity fixture), PNGs rendered with resvg at 64/128/512 as
// the AV1 server does, and `bots.avatar` answered by the wire contract in shared/home-rpc.ts. Counts the
// JSON bytes of every request and answer.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { AVATAR_PACK, AVATAR_PACK_VERSION, canonicalAvatarJson, composeAvatarSvg, parseAvatar, type AvatarJson } from "../shared/avatar";
import { AVATAR_PNG_SIZES } from "../shared/home-rpc";
import { avatarQueryOptions, pruneAvatars, type AvatarAnswer, type AvatarBot, type AvatarNeed, type AvatarRequest } from "../client/avatar-cache";

const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "avatar", "designer-r9.json"), "utf8")) as {
  cases: Array<{ avatar: unknown }>;
};

export function fixtureAvatars(): AvatarJson[] {
  return fx.cases.map((c) => {
    const parsed = parseAvatar(c.avatar, AVATAR_PACK);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.avatar;
  });
}

const renders = new Map<string, Buffer>();
export function renderPng(avatar: AvatarJson, size: number): Buffer {
  const key = `${canonicalAvatarJson(avatar)}@${size}`;
  let png = renders.get(key);
  if (!png) {
    png = Buffer.from(new Resvg(composeAvatarSvg(avatar, AVATAR_PACK), { fitTo: { mode: "width", value: size } }).render().asPng());
    renders.set(key, png);
  }
  return png;
}

const hashOf = (avatar: AvatarJson) => createHash("sha256").update(canonicalAvatarJson(avatar)).digest("base64url").slice(0, 16);
const uri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

export interface HostBot {
  id: string;
  /** Designer avatar; null: an uploaded PNG only (`png`). */
  json: AvatarJson | null;
  png?: Buffer;
}

export interface HostOptions {
  /** false: an older server, ignores `size`/`format` and sends the full 512 avatar.png. */
  sizes?: boolean;
}

export class FakeHost {
  /** JSON bytes of bots.avatar requests + answers. */
  bytes = 0;
  /** JSON bytes of bots.list requests + answers. */
  listBytes = 0;
  calls: AvatarRequest[] = [];
  listCalls = 0;
  constructor(public bots: HostBot[], private readonly options: HostOptions = {}) {}

  private count(request: unknown, answer: unknown, list = false) {
    const n = JSON.stringify(request).length + JSON.stringify(answer).length;
    if (list) this.listBytes += n;
    else this.bytes += n;
  }

  private full(bot: HostBot): Buffer {
    return bot.json ? renderPng(bot.json, 512) : bot.png!;
  }

  hash(bot: HostBot): string {
    return bot.json ? hashOf(bot.json) : createHash("sha256").update(bot.png!).digest("base64url").slice(0, 16);
  }

  list() {
    this.listCalls++;
    const answer = {
      bots: this.bots.map((bot, order) => ({
        id: bot.id,
        name: bot.id,
        cwd: `/bots/${bot.id}`,
        icon: "Bot",
        order,
        avatar: "avatar.png",
        avatarHash: this.hash(bot),
        ...(this.options.sizes === false ? {} : { avatarPack: bot.json ? bot.json.packVersion : null }),
        featured: false,
        agentId: null,
      })),
      ...(this.options.sizes === false ? {} : { avatarPackVersion: AVATAR_PACK_VERSION }),
    };
    this.count({}, answer, true);
    return answer;
  }

  getAvatar = async (request: AvatarRequest): Promise<AvatarAnswer> => {
    this.calls.push(request);
    const bot = this.bots.find((b) => b.id === request.botId);
    let answer: AvatarAnswer;
    if (!bot) answer = { dataUri: null, hash: null };
    else if (this.options.sizes === false) answer = { dataUri: uri(this.full(bot)), hash: this.hash(bot) };
    else if (request.format === "json" && bot.json) answer = { dataUri: null, hash: this.hash(bot), avatar: bot.json };
    else if (request.size && bot.json && (AVATAR_PNG_SIZES as readonly number[]).includes(request.size))
      answer = { dataUri: uri(renderPng(bot.json, request.size)), hash: this.hash(bot), size: request.size };
    else answer = { dataUri: uri(this.full(bot)), hash: this.hash(bot) };
    this.count(request, answer);
    return answer;
  };
}

/** Ten bots with different designer avatars. */
export function tenBots(): HostBot[] {
  const avatars = fixtureAvatars();
  return Array.from({ length: 10 }, (_, i) => ({ id: `bot${i}`, json: avatars[i % avatars.length]! }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * One home refresh: `bots.list`, then each bot's avatar slot mounted (as BotAvatar does) with this need,
 * and pruned once loaded. Returns the observers' data.
 */
export async function refreshHome(client: QueryClient, host: FakeHost, need: AvatarNeed) {
  const { bots } = host.list();
  const out = [];
  for (const listed of bots) {
    const bot: AvatarBot = listed;
    const observer = new QueryObserver(client, avatarQueryOptions(client, bot, host.getAvatar, need));
    const unsubscribe = observer.subscribe(() => undefined);
    await settle();
    await settle();
    const result = observer.getCurrentResult();
    if (result.isSuccess && !result.isPlaceholderData) pruneAvatars(client, bot);
    out.push(result.data);
    unsubscribe();
  }
  return out;
}

export const newClient = () => new QueryClient();
