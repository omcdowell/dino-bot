#!/bin/sh
# Start a herdr worker (pi) on a brief: one workspace per project, one tab per task.
#
#   sh launch.sh <name> <brief-file> <minutes> [cwd]
#
# Run it in the bot's own shell (not in a worker pane). Env:
#   BOT           your bot name (folder under the bots root); default: the current folder when
#                 it is directly under $PASEO_BOTS_ROOT
#   PROJECT       workspace label (default: the last path part of cwd)
#   WORKER_MODEL  pi --model for this worker (default: $BOTS_WORKER_MODEL, the model chosen
#                 for workers in setup; empty: pi's own defaults)
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
  echo "usage: launch.sh <name> <brief-file> <minutes> [cwd]" >&2
  exit 2
}
fail() {
  echo "launch: $*" >&2
  exit 1
}
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

# get <path.to.value>: reads herdr's JSON on stdin (node is always there; jq may not be).
get() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))})' "$1"
}

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

INFO=$(node -e 'const [name,bot,project,workspace,tab,pane,cwd,brief,minutes,model,session_id,session_file]=process.argv.slice(1);process.stdout.write(JSON.stringify({name,bot,project,workspace,tab,pane,cwd,brief,minutes:Number(minutes),model:model||null,session_id,session_file}))' \
  "$NAME" "$BOT" "$PROJECT" "$WS" "$TAB" "$PANE" "$CWD" "$BRIEF" "$MINUTES" "$MODEL" "$SESSION_ID" "$SESSION_FILE")
printf '%s\n' "$INFO" >"${BRIEF%.md}.launch.json"
printf '%s\n' "$INFO"
