# Host settings (`~/bots/.settings.json`)

One file, one schema (`server/settings.ts`). Every key is optional; a bad value falls back to its
default on its own. A public install has no file: bots name the user "the user", there is no
escalation bot (`--kind escalate` is refused with advice), OptChat uses the model the user signed
in with, workers run in the plugin's own herdr session, and no add-ons load.

```json
{
  "user": { "name": "Sam", "aliases": ["sam"] },
  "escalation": "coordinator",
  "defaultModel": "anthropic/claude-sonnet-5-5",
  "herdr": { "session": "paseo-bots" },
  "rooms": { "fullTools": false },
  "extensions": ["/abs/path/to/addon/index.ts"],
  "addons": { "<add-on>": { "url": "http://<usage host>:<port>", "consumer": "<consumer>", "label": "<consumer> pool" } }
}
```

| Key | Default | Used for | Override |
|---|---|---|---|
| `user.name` | `"the user"` | The user's name in bot prompts, DM notes, refusals and the bot-dm block of new bots ("not from Sam"). OptChat bots get it as `BOTS_USER_NAME`. | – |
| `user.aliases` | `[]` | Other party ids that mean the user: `bot-dm <alias>` and old ledger lines read as `user`. OptChat: `BOTS_USER_ALIASES`. | – |
| `escalation` | `null` | Bot that receives `bot-dm --kind escalate` (the "FC" in the DM rules). OptChat: `BOTS_ESCALATE_TO`. | `BOT_DM_FC` (bot-dm) |
| `defaultModel` | `null` | OptChat model for a bot's first chat when neither the bot's `.bot.json` `chat` nor a "bot" agent profile picks one. | – |
| `herdr.session` | `"paseo-bots"` | Named herdr session for workers; `null` = the user's own default herdr server. | – |
| `rooms.fullTools` | `false` | Group chat tools (27 Oct: "A for groupchats with a toggle in settings to go to B"). `false` (A): room sessions talk and look things up, read-only (files only in the room folder and the bots folder, no credentials, public web pages only). `true` (B): the same tools as a bot's main chat (never `ask_user_question`). Set from the app (Settings > host > Agents > "Group chats: full tools", RPCs `rooms.settings` / `rooms.settings.set`). pi-optchat reads this key itself on every room turn (`OPTCHAT_ROOM_SETTINGS`), so a change applies from the next room turn without a reload. | – |
| `extensions` | `[]` | Add-on modules (absolute, or relative to this file) loaded by `server/extensions.ts`. | – |
| `addons.<key>` | `{}` | Config for an add-on, read by the add-on from `api.settings.addons`. A usage add-on can read its own key here (usage source, rate-limit card reset times, Live Activity weekly gate). | add-on's own env |

File location: `PASEO_BOTS_SETTINGS`, else `$PASEO_BOTS_ROOT/.settings.json`, else `~/bots/.settings.json`.

The user's DM party id is always `user` on the wire; the app shows them as "You". The plugin reads
the file once at start (a plugin reload applies a change); bot-dm reads it on every run.

## `models` (setup's "Choose models", rel-demo)

```json
"models": {
  "bots":       { "provider": "openai-codex", "model": "gpt-6-sol",     "thinking": "medium" },
  "compaction": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "low" },
  "workers":    { "provider": "openai-codex", "model": "gpt-6-sol",     "thinking": "high" }
}
```

Written by the `setup.apply` RPC (the app's model step; the lists come from pi). `bots` is the model and effort of new bot chats (it also sets `defaultModel`); `compaction` and `workers` go into each default-following bot's OptChat `config.json` (`compactor`, `subagent`) and `workers` into pi's defaults in the DinoBot pi dir (`PI_CODING_AGENT_DIR/settings.json`), so a plain `pi` in a herdr pane uses it; bots also get it as `BOTS_WORKER_MODEL` ("provider/model:thinking"). `thinking` is null for models without an effort setting. Nothing is hard-coded: with no `models` the plugin names no model and OptChat uses its own default. A bot whose `.bot.json` has its own `chat` (picked by the user) is left alone.
