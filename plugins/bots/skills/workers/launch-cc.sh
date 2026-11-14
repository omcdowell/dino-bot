# Sourced by launch.sh for --engine cc (not run on its own): starts the interactive Claude Code TUI in $PANE.
# In: NAME BRIEF CWD PANE TAB SESSION_ID MODEL, launch.sh's fail() and get(). Out: SESSION_FILE, MODEL, CCDIR.
#
# Per worker, in <brief without .md>.cc/ (CCDIR):
#   plugin/       a session-only plugin (--plugin-dir) whose skills/ are the worker shortlist (links to the
#                 skill folders next to workers/) plus WORKER_SKILLS, as pi's --skill list
#   settings.json --settings: the status line with the spend (cc-status.mjs; nothing blocks a tool call, the
#                 bot stops the worker at its budget, as for pi), tool permissions (a worker runs unattended,
#                 like pi), env: no auto-update, CLAUDE_CODE_TMPDIR=tmp/, a proxy (CC_WORKER_BASE_URL)
#   budget        the budget in US$ (optional; shown in the status line); cost.json the spend so far
# --setting-sources project,local leaves out the user's own settings, hooks, plugins and skills (pi's --no-skills).
HERE=$(cd "$(dirname "$0")" && pwd)
CCDIR="${BRIEF%.md}.cc"
mkdir -p "$CCDIR/plugin/.claude-plugin" "$CCDIR/plugin/skills" "$CCDIR/tmp" || fail "cannot create $CCDIR"
find "$CCDIR/plugin/skills" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
printf '%s\n' '{"name":"worker","version":"1.0.0","description":"Skills for this herdr worker (bots workers shortlist)"}' >"$CCDIR/plugin/.claude-plugin/plugin.json"
cc_skill() {
  [ -f "$1/SKILL.md" ] || { echo "launch: no SKILL.md in $1; skipped" >&2; return 0; }
  ln -sfn "$(cd "$1" && pwd)" "$CCDIR/plugin/skills/$(basename "$1")"
}
case ":${WORKER_SKILLS:-}:" in
  *:none:*) ;;
  *)
    if [ -f "$HERE/worker-skills.txt" ]; then
      for s in $(sed 's/#.*//' "$HERE/worker-skills.txt"); do
        [ ! -f "$HERE/../$s/SKILL.md" ] || cc_skill "$HERE/../$s"
      done
    fi
    ;;
esac
if [ -n "${WORKER_SKILLS:-}" ]; then
  OLDIFS=$IFS
  IFS=:
  for s in $WORKER_SKILLS; do
    [ -z "$s" ] || [ "$s" = none ] || cc_skill "$s"
  done
  IFS=$OLDIFS
fi

# Budget (optional, as for pi): only shown next to the spend; the bot watches it and stops the worker.
BUDGET=${WORKER_BUDGET_USD:-$(grep -oE 'US\$ ?[0-9]+(\.[0-9]+)?' "$BRIEF" | head -n 1 | tr -dc '0-9.')}
printf '%s\n' "$BUDGET" >"$CCDIR/budget"

node -e '
const [dir, script, base, token] = process.argv.slice(1);
const home = require("os").homedir();
const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const settings = {
  // Spend in the status line, as pi shows it; no hook: nothing blocks a tool call.
  statusLine: { type: "command", command: `node ${q(script)} ${q(dir)}`, padding: 0 },
  permissions: {
    defaultMode: "acceptEdits",
    allow: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "Skill", "Task", "TodoWrite"],
  },
  // Token trim (an unattended worker needs none of these; see SKILL.md, "Claude Code workers"): no CLAUDE.md
  // from the home folder (Claude Code reads ~/.claude/CLAUDE.md as the project file of $HOME when it walks up
  // from the cwd), no commit/PR attribution note, no auto memory. Project CLAUDE.md files still load.
  claudeMdExcludes: [home + "/CLAUDE.md", home + "/CLAUDE.local.md", home + "/.claude/**"],
  attribution: { commit: "", pr: "" },
  autoMemoryEnabled: false,
  // No self-update from a worker (it would swap the claude install every other session uses); its temp files in
  // its own folder, not a shared /tmp.
  env: {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_TMPDIR: dir + "/tmp",
    // No side calls: prompt suggestion after every turn, session title, hello/quota probes.
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Built-in skills (dataviz, code-review, claude-api, ...) and agent types out of the skill/agent lists; the
    // worker shortlist (the session plugin) stays.
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    ...(base ? { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token || "proxy" } : {}),
  },
};
// 0600: it can hold the proxy token.
const fs = require("fs");
fs.writeFileSync(dir + "/settings.json", JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(dir + "/settings.json", 0o600);
' "$CCDIR" "$HERE/cc-status.mjs" "${CC_WORKER_BASE_URL:-}" "${CC_WORKER_AUTH_TOKEN:-}" || fail "cannot write $CCDIR/settings.json"

# Model: CC_WORKER_MODEL, else the worker model when it is a Claude one (provider/model:thinking).
EFFORT=
if [ -n "${CC_WORKER_MODEL:-}" ]; then
  MODEL=$CC_WORKER_MODEL
elif [ -n "$MODEL" ]; then
  case $MODEL in
    anthropic/* | claude-*)
      M=${MODEL#anthropic/}
      case $M in *:*) EFFORT=${M##*:} M=${M%%:*} ;; esac
      MODEL=$M
      ;;
    *)
      echo "launch: worker model $MODEL is not a Claude model; Claude Code uses its own default (set CC_WORKER_MODEL)" >&2
      MODEL=
      ;;
  esac
fi
case $EFFORT in low | medium | high | xhigh | max) ;; *) EFFORT= ;; esac

# --tools: only the tools a worker needs (Skill for the shortlist); the rest (Agent, Workflow, AskUserQuestion,
# ScheduleWakeup, ToolSearch and its deferred list, ...) is ~8K tokens on every request. --strict-mcp-config: no
# MCP servers (as pi workers). --exclude-dynamic-system-prompt-sections: no per-machine text in the system prompt.
set -- --session-id "$SESSION_ID" --name "$NAME" --settings "$CCDIR/settings.json" --setting-sources project,local --plugin-dir "$CCDIR/plugin" \
  --tools "${CC_WORKER_TOOLS:-Bash,Read,Edit,Write,Glob,Grep,Skill}" --strict-mcp-config --exclude-dynamic-system-prompt-sections
[ -z "$EFFORT" ] || set -- --effort "$EFFORT" "$@"
[ -z "$MODEL" ] || set -- --model "$MODEL" "$@"
# Own config dir: set in the pane's shell, which herdr then types `claude ...` into. A `claude` shell function (one
# that pins CLAUDE_CONFIG_DIR, as some setups have in .bashrc) would override it, so it is dropped in this pane.
# Same order as the app's Claude Code card (lib/engines.mjs claudeConfigDir): DINOBOT_CLAUDE_CONFIG_DIR, then
# CC_WORKER_CONFIG_DIR; neither: the pane's own CLAUDE_CONFIG_DIR or ~/.claude, the user's own login.
CCCFG=${DINOBOT_CLAUDE_CONFIG_DIR:-${CC_WORKER_CONFIG_DIR:-}}
if [ -n "$CCCFG" ]; then
  mkdir -p "$CCCFG" && CCCFG=$(cd "$CCCFG" && pwd) || fail "cannot create $CCCFG"
  Q=$(printf '%s' "$CCCFG" | sed "s/'/'\\\\''/g")
  herdr pane run "$PANE" "unset -f claude 2>/dev/null; export CLAUDE_CONFIG_DIR='$Q'" >/dev/null || fail "cannot set CLAUDE_CONFIG_DIR in pane $PANE"
  sleep 1
fi
# A folder Claude Code has not been told to trust stops at its "Is this a project you trust?" question (herdr:
# blocked during startup). The bot chose the folder for this worker, so launch answers "Yes, I trust this folder".
if ! OUT=$(herdr agent start "$NAME" --kind claude --pane "$PANE" --timeout 60000 -- "$@"); then
  herdr pane read "$PANE" --source visible --lines 40 2>/dev/null | grep -q 'trust this folder' ||
    fail "claude did not start in pane $PANE (tab $TAB left open to inspect: herdr pane read $PANE --source recent)"
  herdr pane send-keys "$PANE" down enter >/dev/null
  herdr agent wait "$NAME" --until idle --timeout 30000 >/dev/null ||
    fail "claude did not get past the folder trust question in pane $PANE (tab $TAB left open)"
  OUT=$(herdr agent get "$NAME")
fi
SESSION_FILE=$(printf '%s' "$OUT" | get result.agent.agent_session.value)
case $SESSION_FILE in
  /*) ;;
  *) SESSION_FILE="${CCCFG:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects/$(printf '%s' "$CWD" | sed 's/[^A-Za-z0-9]/-/g')/$SESSION_ID.jsonl" ;;
esac
