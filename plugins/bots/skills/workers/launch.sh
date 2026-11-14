#!/bin/sh
# Start a herdr worker (pi, or Claude Code) on a brief: one workspace per project, one tab per task.
#
#   sh launch.sh [--engine pi|cc] <name> <brief-file> <minutes> [cwd]
#
# --engine (or WORKER_ENGINE): pi (default) or cc, the interactive Claude Code TUI (`claude`, run by
# herdr's claude kind). Everything else is the same for both: the brief, the first prompt, the
# bot-dm report, bot-worker add, the skill shortlist. cc only (see SKILL.md, "Claude Code workers"):
#   CC_WORKER_CONFIG_DIR  CLAUDE_CONFIG_DIR for the worker (its own login and settings); empty: the
#                 user's own Claude Code login. DINOBOT_CLAUDE_CONFIG_DIR, when set, comes first
#                 (the login the app's Claude Code card shows)
#   CC_WORKER_BASE_URL    ANTHROPIC_BASE_URL for the worker (a proxy holding the login), with
#                 CC_WORKER_AUTH_TOKEN (default: proxy) as ANTHROPIC_AUTH_TOKEN
#   CC_WORKER_MODEL       claude --model (default: WORKER_MODEL / BOTS_WORKER_MODEL when it is an
#                 anthropic/ model, its :thinking as --effort; else Claude Code's default)
#   CC_WORKER_TOOLS       claude --tools (default Bash,Read,Edit,Write,Glob,Grep,Skill: the token trim)
#   WORKER_BUDGET_USD     budget in US$ shown next to the spend in the status line (default: the
#                 first "US$<n>" in the brief; optional). Advisory, as for pi: the bot stops
#                 the worker at it. Files go to <brief without .md>.cc/
#
# Run it in the bot's own shell (not in a worker pane). Env:
#   BOT           your bot name (folder under the bots root); default: the current folder when
#                 it is directly under $PASEO_BOTS_ROOT
#   PROJECT       workspace label (default: the last path part of cwd)
#   WORKER_MODEL  pi --model for this worker (default: $BOTS_WORKER_MODEL, the model chosen
#                 for workers in setup; empty: pi's own defaults)
#   PI_CODING_AGENT_DIR  pi's folder for sign-ins, settings and packages. The worker uses the
#                 same one as the bots: this variable when set (the daemon's, which the bot's
#                 shell inherits), else DinoBot's own (DINOBOT_PI_DIR, else $DINOBOT_HOME/pi:
#                 where the app's Providers page signs in). Only when that folder exists; else
#                 pi's default (~/.pi/agent).
#   WORKER_SKILLS more skill files or folders for the worker, colon-separated (each becomes
#                 --skill <path>), added to the bundled worker shortlist. The entry `none` drops
#                 the shortlist (WORKER_SKILLS=none: no skills at all; none:/x/y: only /x/y).
# The worker's pi always starts with --no-skills, so it sees only the bundled shortlist
# (worker-skills.txt next to this script: folders next to this skill's folder) plus
# WORKER_SKILLS: not the bot's skills, not the user's global ones, not this one.
# Prints one JSON line (also written to <brief without .md>.launch.json) with the pane and the
# pi session id needed to resume the worker. Exit 0 started, 1 a step failed, 2 usage error.
set -eu

usage() {
  echo "usage: launch.sh <name> <brief-file> <minutes> [cwd]   (first, optional: --engine pi|cc)" >&2
  exit 2
}
fail() {
  echo "launch: $*" >&2
  exit 1
}
ENGINE=${WORKER_ENGINE:-pi}
if [ "${1:-}" = --engine ]; then
  [ $# -ge 2 ] || usage
  ENGINE=$2
  shift 2
fi
case $ENGINE in pi | cc) ;; *) echo "launch: engine must be pi or cc" >&2; exit 2 ;; esac
[ $# -ge 3 ] && [ $# -le 4 ] || usage
NAME=$1
BRIEF=$2
MINUTES=$3
CWD=${4:-$PWD}

printf '%s\n' "$NAME" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || { echo "launch: name must match [a-z][a-z0-9_-]{0,31}" >&2; exit 2; }
case $MINUTES in '' | *[!0-9]*) echo "launch: minutes must be a whole number" >&2; exit 2 ;; esac
[ -f "$BRIEF" ] || { echo "launch: no brief file at $BRIEF" >&2; exit 2; }
[ -d "$CWD" ] || { echo "launch: no folder at $CWD" >&2; exit 2; }
BRIEF="$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")"
CWD=$(cd "$CWD" && pwd)

BOT=${BOT:-}
if [ -z "$BOT" ] && [ -n "${PASEO_BOTS_ROOT:-}" ] && [ "$(dirname "$PWD")" = "${PASEO_BOTS_ROOT%/}" ]; then
  BOT=$(basename "$PWD")
fi
[ -n "$BOT" ] || { echo "launch: set BOT=<your bot name> (or run from your bot folder)" >&2; exit 2; }
PROJECT=${PROJECT:-$(basename "$CWD")}
MODEL=${WORKER_MODEL:-${BOTS_WORKER_MODEL:-}}
SESSION_ID="$NAME-$(date +%Y%m%d-%H%M%S)"
# Claude Code wants a UUID session id.
[ "$ENGINE" != cc ] || SESSION_ID=$(node -e 'process.stdout.write(require("crypto").randomUUID())')

# get <path.to.value>: reads herdr's JSON on stdin (node is always there; jq may not be).
get() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))})' "$1"
}

# Without claude, herdr would wait a minute on a pane that only says "command not found".
[ "$ENGINE" != cc ] || command -v claude >/dev/null 2>&1 ||
  fail "claude (Claude Code) is not on PATH; install it, or use --engine pi"

if herdr agent get "$NAME" >/dev/null 2>&1; then
  fail "a live worker is already named $NAME; pick another name"
fi

# Workspace per project: reuse the one labelled $PROJECT, else create it and use its first tab.
WS=$(herdr workspace list | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const w=(JSON.parse(s).result?.workspaces??[]).find((x)=>x.label===process.argv[1]);process.stdout.write(w?w.workspace_id:"")})' "$PROJECT")
if [ -n "$WS" ]; then
  OUT=$(herdr tab create --workspace "$WS" --cwd "$CWD" --label "$NAME" --no-focus)
  TAB=$(printf '%s' "$OUT" | get result.tab.tab_id)
else
  OUT=$(herdr workspace create --cwd "$CWD" --label "$PROJECT" --no-focus)
  WS=$(printf '%s' "$OUT" | get result.workspace.workspace_id)
  TAB=$(printf '%s' "$OUT" | get result.tab.tab_id)
  herdr tab rename "$TAB" "$NAME" >/dev/null
fi
PANE=$(printf '%s' "$OUT" | get result.root_pane.pane_id)
[ -n "$PANE" ] || fail "herdr gave no pane id: $OUT"

if [ "$ENGINE" = cc ]; then
  . "$(cd "$(dirname "$0")" && pwd)/launch-cc.sh"
else
# Same pi sign-ins as the bots (see PI_CODING_AGENT_DIR above): set in the pane's shell, which herdr
# then types `pi ...` into (after the shell's own start-up files, so they cannot undo it).
PIDIR=${PI_CODING_AGENT_DIR:-}
[ -n "$PIDIR" ] || [ -z "${DINOBOT_HOME:-}${DINOBOT_PI_DIR:-}" ] || PIDIR=${DINOBOT_PI_DIR:-$DINOBOT_HOME/pi}
case $PIDIR in "~") PIDIR=$HOME ;; "~/"*) PIDIR=$HOME/${PIDIR#"~/"} ;; esac
if [ -n "$PIDIR" ] && [ -d "$PIDIR" ]; then
  PIDIR=$(cd "$PIDIR" && pwd)
  Q=$(printf '%s' "$PIDIR" | sed "s/'/'\\\\''/g")
  herdr pane run "$PANE" "export PI_CODING_AGENT_DIR='$Q'" >/dev/null || fail "cannot set PI_CODING_AGENT_DIR in pane $PANE"
  sleep 1
fi
set -- --no-skills --session-id "$SESSION_ID" --name "$NAME"
# Bundled shortlist first (unless WORKER_SKILLS has `none`), then WORKER_SKILLS.
case ":${WORKER_SKILLS:-}:" in
  *:none:*) ;;
  *)
    HERE=$(cd "$(dirname "$0")" && pwd)
    if [ -f "$HERE/worker-skills.txt" ]; then
      for s in $(sed 's/#.*//' "$HERE/worker-skills.txt"); do
        [ ! -f "$HERE/../$s/SKILL.md" ] || set -- "$@" --skill "$(cd "$HERE/../$s" && pwd)"
      done
    fi
    ;;
esac
if [ -n "${WORKER_SKILLS:-}" ]; then
  OLDIFS=$IFS
  IFS=:
  for s in $WORKER_SKILLS; do
    [ -z "$s" ] || [ "$s" = none ] || set -- "$@" --skill "$s"
  done
  IFS=$OLDIFS
fi
[ -z "$MODEL" ] || set -- --model "$MODEL" "$@"
OUT=$(herdr agent start "$NAME" --kind pi --pane "$PANE" --timeout 60000 -- "$@") ||
  fail "pi did not start in pane $PANE (tab $TAB left open to inspect: herdr pane read $PANE --source recent)"
SESSION_FILE=$(printf '%s' "$OUT" | get result.agent.agent_session.value)
fi

PROMPT="Read and carry out $BRIEF (about $MINUTES min). When done, report with: bot-dm $BOT --from worker:$NAME --kind report --text \"<one-line status; report path>\""
arrived() { [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ] && grep -qF "$BRIEF" "$SESSION_FILE"; }
if ! herdr agent prompt "$NAME" "$PROMPT" --wait --until working --until blocked --timeout 60000 >/dev/null; then
  # agent_prompt_stalled / timeout: the prompt may still have arrived (the session file is the
  # record). If not, the text can be sitting unsent in pi's input box (pi was still drawing its
  # start-up notices): one Enter submits it.
  sleep 3
  if ! arrived; then
    herdr agent send-keys "$NAME" enter >/dev/null
    herdr agent wait "$NAME" --until working --until blocked --timeout 20000 >/dev/null 2>&1 || true
    sleep 2
  fi
  arrived || fail "first prompt not confirmed; check with: herdr agent read $NAME --source recent-unwrapped --lines 40"
fi

bot-worker add "$NAME" --pane "$PANE" --bot "$BOT" >/dev/null || echo "launch: bot-worker add failed; run it yourself: bot-worker add $NAME" >&2

INFO=$(node -e 'const [name,bot,project,workspace,tab,pane,cwd,brief,minutes,model,session_id,session_file,engine,cc]=process.argv.slice(1);process.stdout.write(JSON.stringify({name,bot,project,workspace,tab,pane,cwd,brief,minutes:Number(minutes),model:model||null,session_id,session_file,...(engine==="cc"?{engine,cc_dir:cc}:{})}))' \
  "$NAME" "$BOT" "$PROJECT" "$WS" "$TAB" "$PANE" "$CWD" "$BRIEF" "$MINUTES" "$MODEL" "$SESSION_ID" "$SESSION_FILE" "$ENGINE" "${CCDIR:-}")
printf '%s\n' "$INFO" >"${BRIEF%.md}.launch.json"
printf '%s\n' "$INFO"
