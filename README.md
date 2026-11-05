# paseo-bots

Paseo plugin. Adds a **Bots** list to the sidebar header: one row per OptChat bot, with a status
indicator for the bot's chat with you (see "Row status"). Tapping a bot opens its current chat; if it
has none, a chat is created in the bot's folder.

## Host settings, add-ons and the workers' herdr instance

Nothing personal is built in. `<bots root>/.settings.json` (or `PASEO_BOTS_SETTINGS`) sets, per host
(`server/settings.ts`; every key optional, read at plugin start and by each `bot-dm` call):

```json
{
  "user": { "name": "Sam", "aliases": ["sam"] },
  "escalation": "coordinator",
  "defaultModel": "openai-codex/gpt-5",
  "herdr": { "session": "paseo-bots" },
  "extensions": ["/abs/path/to/addon/index.ts"]
}
```

- `user.name`: how prompts, DM notes and refusals name the user (default "the user"). The user's
  party id in DMs and rooms is always `user`; `aliases` are other ids that mean the user
  (`bot-dm <alias>`, and older ledger lines, which read as `user`).
- `escalation`: the bot that gets `escalate` DMs (default none: bot-dm refuses `escalate` and says
  to ask the user). `BOT_DM_FC` still overrides it. OptChat bots get it as `BOTS_ESCALATE_TO`.
- `defaultModel`: OptChat model for a bot's first chat when there is no "bot" agent profile
  (default none: OptChat uses the model the user signed in with).
- `herdr.session`: workers run in a herdr server the plugin starts for itself, a named herdr
  session (default `paseo-bots`), never in the user's own herdr (`server/herdr-instance.ts`).
  Bots get `HERDR_SESSION`/`HERDR_SOCKET_PATH` for it; `null` uses the user's default herdr server.
- `extensions`: add-ons the public plugin does not contain (`server/extensions.ts`): a usage
  source for the rate-limit card and the Live Activity weekly gate, a stall watcher, extra RPCs.
  Without one the card shows no reset time, stalled bots always show, and no stall DMs are sent.
- `addons`: config owned by add-ons, by key (e.g. `addons.<name>` for a usage add-on).
  The public plugin reads none of it. Full table: `docs/settings.md`.

## How bots are found

A bot is any folder under `~/bots` (override with `PASEO_BOTS_ROOT` in the daemon's environment)
containing a `.optchat-profile` file. Optional `.bot.json`:

```json
{ "name": "The Fat Controller", "icon": "Crown", "order": 0 }
```

`name` defaults to the Paseo project name, `icon` to `Bot` (any Lucide name), `order` to 100
(ties sort by name).

## Chats

- New chats use the `bot` agent profile (Settings → Agent profiles) for provider, model and
  thinking; fallback `optchat/anthropic/claude-opus-5-5`, medium.
- Chats are labelled `bot=<id>`. An unlabelled OptChat chat started by hand in a bot's folder is
  adopted.
- **New chat** on the bot page archives the bot's open chats and starts one. Memory lives in the
  OptChat profile, so nothing is lost.

## Row status

| Indicator | State | Detected from |
|---|---|---|
| amber dot | Needs you | Paseo attention, reason `permission` |
| red dot | Error | agent status `error` or attention reason `error` |
| hollow ring | Working | agent status `running` / `initializing` |
| red dot + count | Worker stopped on an error | idle, and a herdr worker it launched stopped on an error without reporting (stalled) |
| accent dot (+ count) | New reply | Paseo attention, reason `finished`, unless only bot DMs started the turns behind it; cleared by Paseo when you open the chat (any device) |
| dashed ring + count | Waiting for workers | idle and read, with herdr workers it launched still running |
| nothing | Read | idle, seen, nothing outstanding |

Priority is in that order. The count beside the dot is the number of outstanding workers (stalled
ones, in red, for the stalled state); it shows while the bot is idle (waiting, stalled or with a new
reply). DMs have no read state.

**Turns started by a DM.** When a bot answers another bot's DM or a worker report, Paseo still sets
the `finished` flag, but the row shows no green dot for it: RPC `bots.quiet` (polled every 10 s, and
again whenever a row's flag switches on) reads the tail of each flagged chat's timeline
(`server/dm-turns.ts`). The row is quiet only when every prompt in the turn that set the flag, in any
later turn, and in an earlier turn that ran straight into it, is a delivered `[dm …]` envelope. A turn
The owner started, or one he wrote into, shows as before; so do needs-you and error. When unsure (history
without turn ids after a reload, a window that may cut the turn off, a read error) the dot shows.

**Workers.** RPC `bots.workers` (polled every 10 s) joins the launch registry
`~/.local/state/bot-dm/launches.jsonl` with `herdr agent list` (`server/workers.ts`). A bot records a
worker with `bin/bot-worker.mjs add <name>` after `herdr agent start <name> …` (launcher = its
`PASEO_AGENT_ID`). Herdr's status decides (2026-10-11): a worker counts while herdr shows it
working or blocked, even after a report, so a mid-job report followed by more work keeps it on the
list. It stops counting once it has sent `bot-dm … --kind report` (a delivered status in
`~/.local/state/bot-dm/workers/<name>/outbox.jsonl`) and is idle/done, when its herdr agent is gone,
or when it is idle/done more than 2 minutes after launch (48 h cap); `bot-worker done <name>` stops
counting it. When herdr cannot give a status (unreadable, or `unknown` for the agent) a report alone
finishes it, as before (this rule follows herdr's measured agent states). Without a registry
entry, a herdr agent that is working or blocked counts for a bot when its cwd is inside the bot's
folder or its name starts with `<bot>-`. If herdr cannot be read, nothing is shown as waiting.
`PASEO_BOTS_HERDR` overrides the herdr binary.

**Stalled workers** (2026-10-10). A registered worker that would count as finished because
herdr says idle/done is *stalled* instead when it stopped on an error (`server/worker-errors.ts`):
the last message in its pi session file (the path herdr reports as `agent_session`) is an assistant
message with `stopReason` `error`/`aborted` (`Request timed out.`, `429 …`, `Connection error.`,
`Operation aborted`, …), written after the launch (and after its last report, if it reported
mid-job and was prompted again). Without a session file the bottom of the pane's
output (`herdr agent read`) is matched against error lines. A stalled worker is not outstanding; the
row shows a red dot with the number of stalled workers. A stall-watch add-on (not in this plugin;
`extensions` setting) may send the bot one DM per stall: `bot-dm <bot> --from worker:stall-watch --kind info`, with the system
nudge line ("not a message from the owner"), naming the worker, pane and error, claimed in
`~/.local/state/bot-dm/stalls.jsonl` and retried with the same DM id (at most 3 tries, 5 min apart).
It goes out when `bots.workers` is polled, i.e. while a Paseo client shows the bots.
`PASEO_BOTS_BOT_DM` overrides the bot-dm binary (default `~/.local/bin/bot-dm`). A stall ends when
the worker reports, `bot-worker done <name>`, its pane closes, or it is resumed (a new prompt).

## DMs

Bots message each other with `bot-dm`, which appends every DM to `~/bots/<bot>/dm/inbox.jsonl`
and `outbox.jsonl` (schema: `shared/dm-schema.ts`). The plugin shows them:

- **Explorer panel (web and desktop).** In a bot's workspace, **DMs** is a tab of the right-hand
  Explorer sidebar, next to Files and Changes. It shows the DMs of the bot whose folder the
  workspace is (matched by directory, `~/bots/<bot>`); any other workspace shows "Not a bot
  workspace". Paseo does not add plugin panels to the Explorer by itself: add it once per bot
  workspace (and per browser or desktop app, since Paseo keeps the layout on the device) with the
  Explorer's **+** (New tab) → **DMs**. After that it stays. A chat card's **Thread** link also
  opens it, adding the tab if it is missing.
- **Phone fallback.** The iOS app (and web narrower than Paseo's compact breakpoint) draws the
  Explorer with built-in tabs only, so the panel cannot appear there. On those clients the Bots
  sidebar shows a plain **DMs** row under each bot that has DMs, opening a full **DMs screen** with
  the same view; chat cards link to that screen. Wide web and desktop do not show these rows.
- **The view.** Thread list (other party, subject, kind, hop count, delivery status, "awaiting
  reply", refused or failed) and thread view (bodies, attachment paths). In the narrow Explorer it
  is one column: the list, then a thread with "‹ Threads". Delivery statuses of worker
  reports come from bot-dm's worker outboxes,
  `~/.local/state/bot-dm/workers/*/outbox.jsonl`. The list and the open thread are polled every 30
  and 10 seconds. There is no unread count or badge: the DMs are between bots and are not addressed
  to you, and nothing tracks what you have read.
- **Reply.** The reply box sends your text into the bot's chat as your own message,
  `Re dm <thread>: <text>`, in steer mode (a busy bot gets it after the current tool call; nothing
  is interrupted), and records it in the bot's inbox as `from: "user"`.
  **Open chat** (DMs screen only) jumps to the bot's chat.
- **Chat cards.** A `[dm …]` message in a bot's chat shows as a "DM from <bot>" card with a
  link to its thread, instead of looking as if you typed it.

The view reads only the last 256 KB of each ledger file (topped up from the newest rotated
file). The plugin keeps no state of its own for DMs. The only ledger lines it writes are
your replies, written by the same code as `bot-dm` (`server/ledger-write.ts`: flock on
`dm/.lock`, one `write()` per line, rotation at 5 MB).

RPCs: `dms.summary`, `dms.threads`, `dms.thread`, `dms.reply`
(`shared/dm-rpc.ts`).

## Designed avatars (avatar.json)

A bot's avatar can be a design from the app's avatar designer instead of a picture. The phone saves only
`~/bots/<bot>/avatar.json` (~200-400 B; schema in `shared/avatar/schema.ts`). The host renders it with resvg
(`server/avatar-store.ts`) into `~/bots/<bot>/avatars/<hash>-{64,128,512}.png`, named by a hash of the JSON,
and copies the 512 px one to `avatar.png` (old one kept as `avatar.png.bak`), so everything that reads
avatar.png keeps working. Only the current and the previous picture's renders are kept. A save whose
`revision` is not above the stored one is refused as `stale` (a resend of the stored save answers ok and
writes nothing). `bots.list` sends the JSON hash as `avatarHash` while avatar.png is still the render; a
picture upload takes over again as before. Bots without avatar.json are unchanged.

RPCs: `bots.avatar-save`, `bots.avatar-json`, `bots.avatar-pack-version`, `bots.avatar-pack`
(`shared/avatar-rpc.ts`; `bots.avatar-pack` answers gzip-base64, or JSON text with `format: "json"`, which the
phone asks for); `bots.avatar` takes an optional `size` (64, 128, 512) and `format: "json"` (the avatar.json
itself, for an app that draws it with SvgXml; `bots.list` `avatarPack` says which bots have one); `bots.create`
and `bots.update` take `avatarJson`.

## Develop

```sh
npm install
npm test
npm run typecheck
paseo plugin reload bots
```

## bot-room (a main chat posts a room task's result to the group)

`bin/bot-room.mjs post <group> --re <msg-id> --text "..."` (or `--file <path|->`) posts into a group chat from a
bot's main chat, as that bot, answering the room message `--re` (the task). The wrapper sends the caller's
`PASEO_AGENT_ID`; the plugin (`rooms.bot-post`) checks that it is a chat of a member bot (room sessions are not),
that `--re` is in that group's ledger and the caps (hop = the --re message's hop + 1, at most 6; one slot of the
room's 6 bot wakes per 10 min), then appends it (`via: "main"`, `re`) and routes it: it wakes only members it
@names. Room tasks end with the exact command. Install like bot-dm:

```sh
ln -s ~/code/paseo-bots/bin/bot-room.mjs ~/.local/bin/bot-room
```

## bot-dm (bot-to-bot DMs)

`bin/bot-dm.mjs` sends a DM from one OptChat bot to another through the Paseo daemon. It lives in
this repo so that the writer of the DM ledger and the plugin's reader share one schema,
`shared/dm-schema.ts`. Install it on PATH with a symlink (Node follows it back to the repo):

```sh
ln -s ~/code/paseo-bots/bin/bot-dm.mjs ~/.local/bin/bot-dm
```

```sh
bot-dm coordinator --kind request --text 'Can I scope AGENTS.md to terminal sessions?'
bot-dm bitzer --kind reply --re 01M4CYXQS6BS5EX6B2QVHCWP03 --text 'Done.'
bot-dm flint --kind report --from worker:wp3-dms-tab --text 'WP3 finished: report at …'   # herdr worker
bot-dm bitzer --kind resume --from worker:ratelimit-watchdog --only-if-idle --text '…'      # system nudge
bot-dm --help
bot-dm user --text 'Sign-in expires at 10:00; re-login needed.'                        # push to the user's phone
```

`bot-dm user` is a DM to the user: it is recorded in the sender's outbox (so it shows in
that bot's DMs tab, status `pushed`) and handed to the separate **paseo-apns** add-on
(`~/code/paseo-apns`, plugin id `apns`) over its 127.0.0.1 endpoint, which pushes it to his phone.
bot-dm reads the endpoint port and notify token from `~/.config/paseo-apns/` (`config.json`,
`notify-token`; `PASEO_APNS_DIR` / `PASEO_APNS_URL` override) and imports nothing from paseo-apns.
One push per 10 minutes from each bot (paseo-apns `rateLimit.perSender`; 2026-10-11): a
herdr worker's push counts towards the bot that launched it (launch registry; bot-dm sends it as
`limitKey`), a schedule run's towards its owning bot, and an unregistered worker has its own slot.
Over that, or with no registered phone or no add-on, it is refused (exit 3) with the reason and the
time the sender's own slot reopens; nothing is queued. Kinds: info or request from bots and
schedule runs, report from workers; system senders never push.

**Slot-open notice.** A bot refused on its own slot gets one system DM when the slot reopens:
`bot-dm <bot> --from worker:push-slot --kind resume`, "Your push slot to the owner is open again (was
refused at HH:MM UTC)". Never after a push that was not refused (each DM costs the bot a turn); one
DM for several refusals in one window. bot-dm records the refusal in
`~/.local/state/bot-dm/push-slots.jsonl`; the bots plugin checks it every 30 s
(`server/push-slot-notify.ts`), so a pending notice survives a plugin reload. Claimed with a DM id
before sending and retried with that id (at most 3 tries, 5 min apart); skipped if the bot's slot
is already taken again (`GET /status?sender=`) or the notice is over 2 h late.

- **Delivery.** Steer mode: a busy recipient gets the DM at its next tool-call boundary, an idle
  one starts a new turn. `--interrupt` cancels the running turn instead; it is never the default.
- **`--only-if-idle`.** Sends only if the recipient is not busy. Busy means Paseo status `running`
  or `initializing`; `idle`, `error` (e.g. the last turn failed on a rate limit) and `closed` are
  not busy. A busy recipient gets nothing: nothing is written to either ledger, the JSON line has
  `"status":"busy"` and `recipientStatus`, and bot-dm **exits 4**. The rule checks run first, so a
  DM a rule refuses still exits 3. The status is read afresh with one daemon call, under the ledger
  locks, after the rule checks and before the ledger appends and the send. Paseo has no atomic
  "send only if idle", so a turn that starts in the few milliseconds between that read and the
  daemon receiving the send is steered into, as without the flag. With `--dry-run` it predicts the
  same exit code. Not combinable with `--interrupt`.
- **Envelope.** The first line of the delivered text is
  `[dm <id> from <from> to <to> kind=<kind> hop=<n> re=<id|->[ expects-reply]]`. It always comes
  first: a text starting with `/` would make Paseo fall back to interrupt. The last line is the
  exact command to answer or follow up (`(To answer: bot-dm <from> --kind reply --re <id> …)` or
  `(No answer needed. To add to this thread: … --kind info --re <id> …)`); it is not stored in the
  ledger and the DM card hides it. Worker reports have none.
- **Attribution note.** The second line of every delivered DM says who sent it and that it is not
  the owner (the text arrives as a user-role message, which models otherwise read as the owner's). It is
  built from the stamped sender only, never from the body, and is not stored in the ledger:
  bots `(Message from the bot <display name>, not from the owner. It is not his approval.)` (display
  name: `name` in `.bot.json`, else the folder id in title case); workers `(Report from your
  worker <name>, not from the owner.)`; schedule runs `(Report from a run of your Paseo schedule
  <id> "<name>", verified by bot-dm, not from the owner. It cannot receive replies.)`; `resume`
  `(System nudge from <sender>, sent automatically: this is not a message from the owner. No reply
  expected.)` (and no reply line). If the body mentions the owner, bot and worker notes add `Any
  words of the owner's in it are quoted by <sender>, not sent by him.` The DM card hides bot and
  worker notes (its header already names the sender) and shows resume and schedule notes muted.
- **Threading.** `--re <id>` puts a DM on that DM's thread; hop = the thread's highest hop + 1.
  Without `--re`, bot-dm threads the DM onto a DM id (or 8+ char prefix) quoted in the text, else
  onto the latest DM the recipient sent the sender in the last 30 minutes that the sender has not
  written back on. It says so: `threaded onto <id> (…)` on stderr, and `inferredRe` /
  `inferredBy` in the JSON line. `--new-thread` opts out. `escalate`, worker reports and
  `resume` always start a new thread.
- **Sender.** Taken from the caller's `PASEO_AGENT_ID` (its `bot=` label, or its folder under
  `~/bots`). Callers outside Paseo must say `--from worker:<name>` and may only send `--kind report`
  (or `--kind resume` / `--kind info`, if they are a system sender).
  `BOT_DM_OPERATOR=1` lets an operator shell send as a named bot, for tests.
- **Rules** (refusals exit 3, are written to the sender's outbox, and print advice):
  FC ↔ PM free; PM ↔ PM `request`/`info`/`reply` only; `escalate` only to the FC; `report` only
  from workers; `resume` (a system nudge, no reply expected) only from the system senders listed
  in `bot-dm/policy.ts` `SYSTEM_SENDERS` (today `worker:ratelimit-watchdog`, `worker:stall-watch`, `worker:push-slot`), to any bot, who may
  also send `info` (a system notice, same nudge line); at most
  6 hops per thread; at most 10 DMs per pair of bots per 30 minutes, any thread, FC ↔ PM pairs
  included (refused as `hop_cap`; `escalate` to the FC exempt). The pair limit is between bots
  only: it does not apply to `worker:` senders (reports and `resume`). At most 20 DMs per hour
  per sender → recipient, workers included;
  no `--kind reply` to a `reply`/`info` unless it was sent with `--expects-reply` (a follow-up
  with `--kind info --re <id>` is allowed and counts a hop); body ≤ 4,000 chars
  (use `--attach <absolute path>` for more).
- **Exit codes.** 0 sent (or already sent), 1 delivery failed (retry with `--id`), 2 usage error,
  3 refused by a rule, 4 recipient busy with `--only-if-idle` (nothing written or sent).
- **Recipients.** A live chat labelled `bot=<name>`, else an unlabelled OptChat chat in
  `~/bots/<name>` (same rule as the sidebar). Unknown names are refused.
- **Ledger.** `~/bots/<name>/dm/outbox.jsonl` (sender: message + status records) and
  `inbox.jsonl` (recipient: message record). Worker outboxes are under
  `~/.local/state/bot-dm/workers/<name>/`. `dm/` is 0700, files 0600, one record per `write()`,
  under `flock` on `dm/.lock`; files rotate to `<name>-YYYY-MM.jsonl` past 5 MB. Retrying with
  `--id <id>` reuses the DM id as Paseo's `messageId`, so the daemon drops duplicates.
- **Environment.** `PASEO_BOTS_ROOT` (default `~/bots`), `BOT_DM_FC` (default
  `the-fat-controller`), `BOT_DM_RECIPIENT_PREFIX` (test fence, e.g. `tmp-`), `PASEO_CLI_DIST`.

### Bots' AGENTS.md paragraph

The paragraph that tells bots how to use `bot-dm` lives once, in `docs/bot-dm-agents-snippet.md`.
`bin/bot-dm-snippet-sync` writes it into every OptChat profile's `AGENTS.md` between
`<!-- bot-dm:begin v1 -->` and `<!-- bot-dm:end -->`, replacing an existing block in place
(`--dry-run` to preview, `--profiles <dir>` for another OptChat home). Bots pick it up on reload.

### After a Paseo upgrade

bot-dm imports two Paseo CLI internals (`dist/utils/client.js`, `dist/utils/daemon-target.js`).
They are pinned in `bot-dm/paseo.ts` (`PINNED_CLI_VERSIONS`); an unlisted version still works but
warns on stderr. After upgrading, run the smoke test, with a throwaway `tmp-*` bot for the live part,
and add the version to the list if it passes:

```sh
npm run smoke:bot-dm                       # static and read-only daemon checks
node bin/bot-dm-smoke.mjs --live tmp-dm-b  # also idle start, steer into a busy turn, dedupe
```

## Licence

Apache-2.0, Copyright 2026 omcdowell. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled dependency: zod (MIT). The DinoBot name and the dino artwork are not covered by the licence.
