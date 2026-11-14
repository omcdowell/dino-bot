---
name: workers
description: Run herdr worker agents (pi sessions, or Claude Code with --engine cc, in herdr panes) for a bot. Use when a task is big enough to hand off to a worker; covers the brief, starting (launch.sh), reporting, steering, budgets, checking the result, recovery after a crash or stall, and closing.
---

# Workers

A worker is a pi session (or, with `--engine cc`, an interactive Claude Code session; section 9)
in a herdr pane that does one task for you and reports back with `bot-dm`. You brief it, start it, check on it, verify what it did and close it. Its report is
a claim, not a result: the task is done only when you have checked the work yourself.

Your shell already points `herdr` at the workers' own herdr instance (`HERDR_SESSION` and
`HERDR_SOCKET_PATH` are set for you); do not change them. herdr commands print JSON; read ids
from it, never guess them. `launch.sh` is next to this file; `herdr --skill` prints herdr's
own guide if you need a command not covered here.

## 1. Brief: one task, one file

Write the brief to a file before starting anything (for example `<your bot folder>/tasks/<task>.md`).
One task per worker. The brief says:

- **Goal**: what "done" looks like, in one or two sentences, and how you will check it.
- **Where**: repo, branch to start from, the worktree or folder to work in. Never your own
  checkout or another worker's.
- **Rules**: what it must not do (push, merge, deploy, restart services, edit files outside
  its folder, commit trailers such as Co-Authored-By if the project forbids them).
- **Budget**: a spend budget in US$ ("Budget: US$5") and a time estimate in minutes (section 5).
- **Report**: the report file path (`<task>.report.md` next to the brief) and what goes in it:
  files changed, commits, test commands with pass/fail counts, open questions.
- **How to report**: `bot-dm <your bot> --from worker:<name> --kind report --text "<one-line status; report path>"`.

Layout: one herdr **workspace per project**, one **tab per task**. `launch.sh` does this.

Estimates are LLM time: a worker task takes minutes to an hour, not days or weeks. Size and
describe tasks that way ("about 20 min"), and split anything that looks longer than an hour.

## 2. Start

Use the bundled script (run it in your own shell, not in a worker's pane):

```sh
sh <this skill dir>/launch.sh [--engine pi|cc] <name> <brief-file> <minutes> [cwd]
```

- `--engine`: `pi` (the default; also `$WORKER_ENGINE`) or `cc` for Claude Code (section 9). Use
  `cc` only when the user asks for Claude Code workers; other providers run through pi.

- `<name>`: the worker and tab name, `[a-z][a-z0-9_-]{0,31}`, unique among live workers.
- `<cwd>`: the folder the worker runs in (default: the current directory). Its last path
  part is the project, i.e. the workspace label (override with `PROJECT=<label>`).
- Your bot name (the folder under the bots root) comes from `$BOT`, or from the current
  directory when you run it from your bot folder.
- Model: `$WORKER_MODEL` if set, else `$BOTS_WORKER_MODEL` (the model and effort the user
  chose for workers in setup, as `provider/model:thinking`). If both are empty, `pi` uses its
  own defaults from setup. Pick another model only when the user asks.
- Sign-ins: the worker's pi uses the same pi folder as the bots (`$PI_CODING_AGENT_DIR`, else
  DinoBot's own, where the app's Providers page signs in), so a sign-in there reaches workers
  too. When none is set, pi's default `~/.pi/agent`.
- Skills: the worker shortlist only. The worker's pi starts with `--no-skills` plus
  `--skill <folder>` for each skill named in `worker-skills.txt` next to `launch.sh`
  (`diagnose`, `tdd`, `screenshot-app`, `herdr`; their folders sit next to this skill's
  folder). It does not see your skills, the user's global skills or this one (workers do not
  start workers). `WORKER_SKILLS=<skill folder>[:<another>]` adds more (each becomes
  `--skill <path>`); an entry `none` drops the shortlist (`WORKER_SKILLS=none`: no skills).

What it does, so you can do it by hand if needed:

```sh
herdr workspace create --cwd <cwd> --label <project> --no-focus   # once per project: .result.workspace.workspace_id, .result.tab.tab_id, .result.root_pane.pane_id
herdr tab create --workspace <workspace_id> --cwd <cwd> --label <name> --no-focus   # each further task: .result.root_pane.pane_id
herdr pane run <pane_id> "export PI_CODING_AGENT_DIR='$PI_CODING_AGENT_DIR'"   # only when it is set
herdr agent start <name> --kind pi --pane <pane_id> --timeout 60000 -- --model "$BOTS_WORKER_MODEL" --no-skills --skill <skills dir>/diagnose --skill <skills dir>/tdd --skill <skills dir>/screenshot-app --skill <skills dir>/herdr --session-id <session-id> --name <name>
herdr agent prompt <name> "Read and carry out <brief> (about <minutes> min). When done, report with: bot-dm <bot> --from worker:<name> --kind report --text \"...\"" --wait --until working --until blocked --timeout 60000
bot-worker add <name>          # in YOUR shell, right after the first prompt
```

`<skills dir>` is the folder that holds this skill's folder (one `--skill` per name in
`worker-skills.txt`, plus any `WORKER_SKILLS` paths).

The script prints one JSON line (also saved as `<brief>.launch.json`): name, bot, workspace,
tab, pane, cwd, `session_id` and `session_file`. Keep it: you need the session id to resume.

## 3. Reports

The worker ends with `bot-dm <your bot> --from worker:<name> --kind report --text "..."`; it
arrives as a DM in your chat. `bot-worker add` makes your sidebar row show "waiting for
workers" until the worker reports, goes idle or its pane closes. `bot-worker list` shows each
worker's state: running, blocked, stalled (with the error) or unknown.

## 4. Steer

```sh
herdr agent prompt <name> "<text>" --wait --until working --until blocked --timeout 60000
herdr agent read <name> --source recent-unwrapped --lines 80     # what it is doing
herdr agent get <name>                                           # state; .result.agent.agent_session.value = session file
```

- `agent_blocked`: the worker is at a question or approval prompt; nothing was sent. Read the
  pane (`herdr agent read`) and decide; do not approve anything the user has not approved.
- `agent_prompt_stalled` or `timeout` does not prove the prompt was lost. Before sending it
  again, check it arrived: `grep -c '<a distinctive phrase from your prompt>' <session_file>`.
  If it is there, wait. If not, read the pane: text left unsent in pi's input box (common
  right after start-up) needs only `herdr agent send-keys <name> enter`; otherwise send it once more.
- Prompting a worker that is busy queues the text as a steer for its running turn.

## 5. Budgets

Put a budget in every brief ("Budget: US$5"). It is the same for pi and Claude Code workers:
the worker shows its session's spend in its status line, the last lines of the pane, and you
watch it; nothing in the worker blocks its tools.

```sh
herdr agent read <name> --source visible --lines 4 | grep -o '\$[0-9][0-9.]*'
```

pi shows `$<spent>`; a Claude Code worker shows `$<spent>`, or `$<spent> / budget $<n>` when
the brief has a `US$<n>` figure (section 9). `(sub)` after the figure means a subscription: the
figure is what the same tokens would cost at API prices; still hold the budget. Check the
spend when you check progress. At the budget, stop the worker (`herdr agent send-keys <name>
esc`, then ask it to write its report so far) and decide with the user whether it is worth more.

## 6. Check the work (never trust a report)

A report is a claim. Before you tell anyone a task is done:

- **Commits**: `git log --oneline <base>..<branch>` and `git show --stat` in the repo; the
  commits exist, are on the right branch, and touch only what the brief allowed.
- **Tests**: run the test commands yourself in a fresh worktree or clone of that branch
  (`git worktree add <tmp dir> <branch>`), not in the worker's folder, and compare pass counts
  with the report.
- **Claims**: re-check each factual claim the report makes (a file exists, a flag works, a bug
  no longer reproduces) with your own command.
- **Trailers**, if the project forbids them:
  `git log --format=%B <base>..<branch> | grep -iE '^(co-authored-by|signed-off-by):'` must print nothing.
- **Rules**: nothing pushed, merged or deployed that the brief did not allow.

If something is wrong, send the worker the exact failure (section 4) rather than fixing it
quietly; then check again.

## 7. Recovery

- **pi exited mid-task** (the tab shows a shell prompt, `herdr agent get <name>` says not
  found): start pi again in the **same pane** (same folder) with the **same session id**, then
  re-prompt. `--session-id` reopens the existing session, so the worker keeps its context:

  ```sh
  herdr agent start <name> --kind pi --pane <pane> --timeout 60000 -- --model "$BOTS_WORKER_MODEL" --no-skills --skill <skills dir>/diagnose --skill <skills dir>/tdd --skill <skills dir>/screenshot-app --skill <skills dir>/herdr --session-id <session_id> --name <name>
  herdr agent prompt <name> "pi restarted. Carry on with <brief> from where you stopped; check git status first." --wait --until working --until blocked --timeout 60000
  ```

  The session id is project-scoped: run it in the same folder, or pi starts a new, empty session.
- **Rate limit, overload (429/503/529) or network errors**: pi retries by itself. If the worker
  went idle on an error without reporting (`bot-worker list` shows it as stalled; a stall-watch
  add-on, if the host has one, also DMs you), wait a few minutes, then prompt it to continue. Do not start a second worker on the same task.
- **Blocked** for a long time: read the pane, then answer or press `esc` (`herdr agent send-keys`).

## 8. Close

When the work is checked (or you stop waiting on it):

```sh
bot-worker done <name>              # stop counting it (also clears a stalled worker)
herdr tab close <tab_id>            # ends the worker's pi
herdr workspace close <workspace_id>   # when the project's last task is closed
```

Close only tabs and workspaces you created. A daily cleanup may close workers idle for about
two days, but close yours yourself when they are done.

## 9. Claude Code workers (`--engine cc`)

The plain interactive Claude Code TUI (`claude`, herdr's `claude` kind) in the pane; never
`claude -p`. Same brief, first prompt, `bot-dm` report, `bot-worker add`/`done`, shortlist.
Differences:

- **Files**: `<brief without .md>.cc/` holds `settings.json` (passed with `--settings`),
  `plugin/` (a session-only plugin whose `skills/` links the shortlist plus `WORKER_SKILLS`; the
  worker sees them as `worker:tdd` and so on), `budget` and `cost.json`.
  `--setting-sources project,local` keeps the user's own settings, hooks, plugins and skills out
  (as pi's `--no-skills`).
- **Token trim** (first request ~8.2K tokens instead of ~19.9K): `--tools
  Bash,Read,Edit,Write,Glob,Grep,Skill` (override with `CC_WORKER_TOOLS`), `--strict-mcp-config`
  (no MCP servers), `--exclude-dynamic-system-prompt-sections`; in `settings.json` no CLAUDE.md
  from the home folder (`claudeMdExcludes`; the project's own CLAUDE.md still loads), no
  attribution note, no auto memory; env: no prompt suggestion, session title or other
  non-essential traffic, no built-in skills, Artifact or Workflow. Auto-compact stays on.
- **Login**: `CC_WORKER_CONFIG_DIR=<dir>` gives the worker its own `CLAUDE_CONFIG_DIR` (its own
  login, or none when it goes through a proxy). Empty: the user's own Claude Code login.
  `DINOBOT_CLAUDE_CONFIG_DIR`, when set, comes first: the login the app's Claude Code card shows.
  `CC_WORKER_BASE_URL=<url>` (with `CC_WORKER_AUTH_TOKEN`) sends it through a proxy that holds
  the login. A folder Claude Code has not trusted yet is accepted for it at start.
- **Model**: `CC_WORKER_MODEL` (`--model`), else the worker model when it is `anthropic/...`
  (its `:thinking` becomes `--effort`), else Claude Code's default.
- **Session**: `session_id` in the launch JSON is a UUID; `session_file` is Claude Code's
  transcript (`<config dir>/projects/<cwd with / as ->/<uuid>.jsonl`).
- **Budget**: as for pi (section 5): the bot watches the spend and stops the worker at its
  budget; no hook blocks a tool call, and a budget is optional. The status line
  (`cc-status.mjs`) shows Claude Code's own session cost (API prices, subagents included; it
  keeps counting across a restart, saved in `cost.json`) and, when there is one, the budget:
  `$WORKER_BUDGET_USD`, else the first `US$<n>` in the brief, written to `.cc/budget` (write
  another number there to change what it shows). Spend: read the pane or
  `cat <brief>.cc/cost.json`.
- **Restart** (claude exited): in the same pane, `CLAUDE_CONFIG_DIR` as before,
  `herdr agent start <name> --kind claude --pane <pane> --timeout 60000 -- --resume <session_id> --settings <brief>.cc/settings.json --setting-sources project,local --plugin-dir <brief>.cc/plugin --tools Bash,Read,Edit,Write,Glob,Grep,Skill --strict-mcp-config --exclude-dynamic-system-prompt-sections`,
  then prompt it to carry on.
- Workers never update Claude Code themselves (`DISABLE_AUTOUPDATER`), and keep their temp
  files in `.cc/tmp` (`CLAUDE_CODE_TMPDIR`).
