# paseo-apns

Paseo plugin (id `apns`): direct APNs push for a self-built iOS Paseo app. Node built-ins only at
runtime (`node:http2`, `node:crypto`); `zod` and the plugin SDK come from the daemon.

## When to use it (plugin option)

This plugin signs pushes with an APNs `.p8` key that lives on the daemon machine. Apple only
accepts a key for apps of the key's own team, so it works only when **the person running the
daemon also signs the iOS app** (a self-built app, Xcode or their own TestFlight). It is not the
push path for a public build: testers of a public TestFlight cannot hold the publisher's key.
Without a `config.json` the plugin runs in `local` mode: no remote push, and the Live Activity
is updated by the app itself while it is open.

**In DinoBot** this plugin ships in the tarball (`app/apns`) but is off: the installer never
registers it. `dinobot push enable` turns it on and writes its config to `~/.dinobot/apns`;
see `docs/live-activities.md` in the DinoBot repo. The steps below are for a plain Paseo host.

Install it as an optional, separate plugin; nothing in the app needs it. With the plugin
missing, the app skips APNs registration and the Live Activity sync (a warning once per session).

Setup (once per daemon machine):

1. Apple Developer → Keys → new key with "Apple Push Notifications service (APNs)"; download
   the `.p8` (one download only). Note the key id and team id.
2. `node bin/setup.mjs --key-path /abs/AuthKey_<KEYID>.p8 --key-id <KEYID> --team-id <TEAMID> --topic <bundle id>`
3. Build the app with `PASEO_PUSH_TRANSPORT=apns` and `PASEO_APNS_ENVIRONMENT=production` for
   TestFlight / App Store signing, or `development` for Xcode / development-profile builds.

## Pieces

| File | What |
|---|---|
| `server/jwt.ts` | ES256 provider token. Key read by path only while minting; reused 40 min (config 20-50); refresh never inside 20 min. Errors carry the error code only. |
| `server/apns-client.ts` | One HTTP/2 session per host (sandbox / production), payload builder (no badge, data under top-level `body` for expo-notifications), Apple error mapping. |
| `server/devices.ts` | Device registry `devices.json` (600). No lease; tokens leave on 410 / BadDeviceToken / DeviceTokenNotForTopic or `revoke`. |
| `server/rate-limit.ts` | One push per window (default 600 s), global, or per sender with `perSender` (a push's `limitKey`, e.g. a worker's launching bot, picks the slot). Refuse, never queue. Restored from the log after a reload, keyed the same way. |
| `server/push-log.ts` | Append-only `push-log.jsonl` (600): sent, refused, failed, registered, revoked, token-dropped. Token tails only. |
| `server/endpoint.ts` | `127.0.0.1:<port>`: `POST /notify`, `GET /status[?sender=]`, bearer notify token. |
| `shared/rpc.ts` | Plugin RPC `register` / `revoke` for the app. |
| `bin/setup.mjs` | Writes `config.json` and the notify token. Never opens the key. |

State dir: `~/.config/paseo-apns/` (700), or `$PASEO_APNS_DIR`.

```json
{
  "keyPath": "/path/to/AuthKey_<KEY_ID>.p8",
  "keyId": "XXXXXXXXXX",
  "teamId": "YYYYYYYYYY",
  "topic": "com.example.paseo",
  "port": 6790,
  "rateLimit": { "windowSeconds": 600, "perSender": true },
  "jwtReuseMinutes": 40
}
```

## Endpoint

```
POST /notify  Authorization: Bearer <notify-token>
  {"sender":"helper","limitKey":"…","title":"Helper","body":"…","data":{…},"collapseId":"…"}
  limitKey (optional): whose slot the push uses in perSender mode (default: sender)
200 {"ok":true,"code":"sent","sent":1,"failed":0,"devices":[…],"nextSlotAt":"…"}
429 {"ok":false,"code":"rate_limited","retryAt":"…","retryInSeconds":420,"message":"…"}   (Retry-After)
409 {"ok":false,"code":"no_device",…}     503 not_configured | key_error     502 apns_failed
GET /status[?sender=helper] -> {"ok":true,"configured":true,"devices":1,"environments":["development"],"nextSlotAt":null,…}
  nextSlotAt: the global slot, or in perSender mode that sender's slot (null without ?sender=)
```

The payload is `{"aps":{"alert":{"title","body"},"sound":"default"},"body":{"kind":"alert","serverId":…,…data,"source":"paseo-apns"}}`.
`source` is always set last; the app shows a foreground banner only for that source.

## Live Activity (busy bots)

A second channel next to alerts (`server/live-activity.ts`): one Live Activity on the phone that
lists the bots that are working or have herdr workers out.

- The bots plugin POSTs the busy set to `POST /live-activity {sender, bots:[{id,name,working,workers,since}]}`
  (same bearer) whenever it changes.
- The app calls the `live-activity.sync` RPC on connect, token change and foreground with its
  install id, push-to-start token and activities; the answer is the state to show (null = end).
  It also sends the phone's `appearance` (`light`/`dark`); that install's pushes carry it in the
  content state, because on iOS 26 the widget always gets the dark colour scheme. Likewise its
  Lock Screen dino setting (`dinoLayers`, 3 or 6), which the widget cannot read on the phone.
- Pushes: `apns-push-type: liveactivity`, topic `<topic>.push-type.liveactivity`, priority 10;
  start (to the push-to-start token, `attributes-type: PaseoBotsAttributes`, alert without sound,
  required by Apple), update, end (`dismissal-date` now). `stale-date` = now + 30 min, refreshed
  by a heartbeat every 20 min while busy; an activity is ended and restarted before iOS's 8 h cap.
- 5 s window from the first change: everything inside it is one push; a set that settles back to
  what the phone shows sends nothing; pushes are never closer than 5 s.
- Not alerts: logged as `la-start` / `la-update` / `la-end` / `la-failed` / `la-sync`, never `sent`,
  so the one-alert-per-10-min limit neither counts nor blocks them. State: `live-activities.json` (600).

## Key handling

- The .p8 is never read except inside `ProviderToken.mint()`, never logged, never in config, argv or env.
- Load/sign failures log only the error code (`ENOENT`, `ERR_OSSL_*`).
- Tests generate throwaway P-256 keys in a temp dir and talk to a fake APNs over h2c.
- Never take a heap dump of the plugin process.

## Develop

```sh
npm install
npm test
npm run typecheck
```
