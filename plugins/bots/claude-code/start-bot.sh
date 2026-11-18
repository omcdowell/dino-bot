#!/bin/sh
# Starts a bot's Claude Code TUI in the bots' herdr session: tab cc-<bot> in workspace "bots", the bot's folder as
# its cwd, the OptChat mods next to this script. The bots plugin (server/cc/launch.ts) runs it when the bot's chat
# opens and no TUI is running; it uses the cc workers' launch-cc.sh, so bots and workers start the same way, on the
# user's own Claude Code login.
#
# In (env): BOT, CWD (the bot's folder), CCDIR (its state folder: env.sh with the bot's environment, written by the
# plugin, 0600), CC_WORKER_MODEL / CC_WORKER_EFFORT (optional), CLAUDE_DIR (folder holding `claude`, put first on
# PATH), CC_PROXY=1 (env.sh carries the owner's Anthropic API proxy: launch.ts ccProxyFor), CC_BOTS_WORKSPACE (the herdr
# workspace label, default "bots"; the release smoke test, scripts/cc-smoke.ts, uses its own). Prints one JSON line
# {pane, tab, session_file}. Exit 0 started (or already running), 1 a step failed.
set -eu
fail() {
  echo "start-bot: $*" >&2
  exit 1
}
get() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))})' "$1"
}
HERE=$(cd "$(dirname "$0")" && pwd)
: "${BOT:?}" "${CWD:?}" "${CCDIR:?}"
NAME="cc-$BOT"
WS_LABEL=${CC_BOTS_WORKSPACE:-bots}
[ -f "$CCDIR/env.sh" ] || fail "no $CCDIR/env.sh"
[ -z "${CLAUDE_DIR:-}" ] || PATH="$CLAUDE_DIR:$PATH"
command -v claude >/dev/null 2>&1 || fail "Claude Code (claude) is not installed"
if herdr agent get "$NAME" >/dev/null 2>&1; then
  printf '{"running":true}\n'
  exit 0
fi

WS=$(herdr workspace list | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const w=(JSON.parse(s).result?.workspaces??[]).find((x)=>x.label===process.argv[1]);process.stdout.write(w?w.workspace_id:"")})' "$WS_LABEL")
if [ -n "$WS" ]; then
  OUT=$(herdr tab create --workspace "$WS" --cwd "$CWD" --label "$NAME" --no-focus)
  TAB=$(printf '%s' "$OUT" | get result.tab.tab_id)
else
  OUT=$(herdr workspace create --cwd "$CWD" --label "$WS_LABEL" --no-focus)
  TAB=$(printf '%s' "$OUT" | get result.tab.tab_id)
  herdr tab rename "$TAB" "$NAME" >/dev/null
fi
PANE=$(printf '%s' "$OUT" | get result.root_pane.pane_id)
[ -n "$PANE" ] || fail "herdr gave no pane id: $OUT"
Q=$(printf '%s' "$CCDIR/env.sh" | sed "s/'/'\\\\''/g")
if [ "${CC_PROXY:-}" = 1 ]; then
  # Through the owner's proxy (env.sh holds ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN): the shell's own Claude API
  # settings go first, then env.sh puts back only the proxy.
  herdr pane run "$PANE" "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; . '$Q'" >/dev/null ||
    fail "cannot load the bot's env in pane $PANE"
else
  herdr pane run "$PANE" ". '$Q'" >/dev/null || fail "cannot load the bot's env in pane $PANE"
fi
sleep 1

# A login made with `claude auth login` alone never saw the TUI's first-run screens (text style, notes), which would
# hold an unattended bot: mark them done in that login's .claude.json (only that key and a theme are added).
node -e '
const fs = require("fs"), path = require("path");
const dir = process.env.DINOBOT_CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, ".claude.json") : path.join(require("os").homedir(), ".claude.json");
let j = {};
try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") process.exit(0); }
if (j.hasCompletedOnboarding === true) process.exit(0);
j.hasCompletedOnboarding = true;
j.theme ??= "dark";
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file + ".tmp", JSON.stringify(j, null, 2), { mode: 0o600 });
fs.renameSync(file + ".tmp", file);
' || echo "start-bot: could not mark Claude Code onboarding done" >&2

# launch-cc.sh's inputs. No worker skills; web search and fetch (as pi bots' pi-web-access); OptChat's tools (zoom,
# date, search_memory come from the view mod); no AskUserQuestion (it would hold the TUI: the bot asks in its reply); the
# three mods and the restart guard; no slash commands or skills in the prompt.
SESSION_ID=$(node -e 'process.stdout.write(require("crypto").randomUUID())')
BRIEF="$CCDIR/bot.md"
MODEL=
WORKER_SKILLS=none
# Claude Code's own auto-compact window, not the workers' 200k cap: OptChat compacts after each turn, as for a pi bot.
CC_COMPACT_WINDOW=auto
CC_WORKER_TOOLS=${CC_WORKER_TOOLS:-Read,Edit,Write,Bash,Grep,Glob,WebSearch,WebFetch,zoom,date,search_memory}
# guard: the restart guard (a stock PreToolUse hook on Bash, the same rules as pi bots' OptChat hook); bots only, never
# workers (launch.sh) or the user's own Claude Code.
CC_PLUGIN_DIRS="$HERE/view:$HERE/trigger:$HERE/inbox:$HERE/guard"
CC_EXTRA_ARGS=--disable-slash-commands
# The plan login only (no ANTHROPIC_* in the pane), unless the owner chose a proxy (CC_PROXY=1, set above).
if [ "${CC_PROXY:-}" = 1 ]; then unset CC_PLAN_LOGIN; else CC_PLAN_LOGIN=1; fi
unset WORKER_BUDGET_USD
printf 'Claude Code TUI of the DinoBot bot %s (no brief).\n' "$BOT" >"$BRIEF"
CC_HERE=$(cd "$HERE/../skills/workers" && pwd)
. "$CC_HERE/launch-cc.sh"
node -e 'const [pane,tab,session_file]=process.argv.slice(1);process.stdout.write(JSON.stringify({pane,tab,session_file})+"\n")' "$PANE" "$TAB" "$SESSION_FILE"
