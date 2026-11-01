#!/bin/bash
# macOS end-to-end, run ON the Mac (test/run-mac-e2e.sh copies it there with the tarball).
# Throwaway HOME under /tmp (90 characters, so herdr's short sockets are exercised too), its own
# port, launchd agents under a unique label loaded from the throwaway HOME, all removed afterwards.
# Never touches the real ~/.paseo, ~/Library/LaunchAgents or any other Paseo install.
#
#   e2e-mac.sh <dir with tarball + install.sh>   (PORT default 6795)
set -uo pipefail
DIR=$1
PORT=${PORT:-6795}
LABEL=test.relinst2.$(date +%s)
LOCK=$HOME/code/paseo-sim/.paseo-build.lock
UIDN=$(id -u)
ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }
step() { echo "[$(( ($(ms) - T0) ))ms] $*"; }
T0=$(ms)

# Mac rules: charger guard, then the build lock (one heavy job on the Mac at a time).
if [ -x ~/.charger-watch/bin/charger-guard ] && ! ~/.charger-watch/bin/charger-guard; then echo "on battery (charger-guard): stop"; exit 75; fi
waited=0
until shlock -f "$LOCK" -p $$; do
  [ $waited = 0 ] && echo "build lock held by pid $(cat "$LOCK" 2>/dev/null); waiting"
  sleep 10; waited=$((waited + 10)); [ $waited -lt 3600 ] || { echo "gave up on the lock"; exit 75; }
done
step "got the Mac build lock (waited ${waited}s)"

H=/tmp/dbt/h; while [ ${#H} -lt 90 ]; do H=${H}x; done
rm -rf /tmp/dbt/h*; mkdir -p "$H"
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
BW() { env -i HOME="$H" USER="$USER" PATH=/usr/bin:/bin DINOBOT_ALLOW_UNSIGNED=1 OPENROUTER_API_KEY=sk-or-fake-e2e "$H/.dinobot/bin/dinobot" "$@"; }
cleanup() {
  step "cleanup"
  BW uninstall --purge 2>&1 | tail -1
  for l in daemon herdr herdr-gc; do launchctl bootout "gui/$UIDN/$LABEL.$l" 2>/dev/null; done
  sleep 1
  left=$(launchctl list | grep -c "$LABEL" || true)
  [ "$left" = 0 ] && echo "ok   no launchd jobs left under $LABEL" || { echo "FAIL $left launchd jobs left"; launchctl list | grep "$LABEL"; }
  pkill -f "$H/" 2>/dev/null; sleep 1
  pgrep -f "$H/" >/dev/null && echo "FAIL processes left" || echo "ok   no processes left from the temp HOME"
  rm -rf /tmp/dbt "$DIR"
  rm -f "$LOCK"
  echo "ok   temp HOME, tarball and lock removed"
}
trap cleanup EXIT

echo "== Mac load before install: $(uptime | sed 's/.*load averages*: //'); busiest: $(ps -Ao pcpu,comm -r | sed -n '2,4p' | awk '{printf "%s%% %s; ", $1, $2}')"
echo "== HOME (${#H} chars) $H, port $PORT, launchd label $LABEL"
step "install (launchd, tarball from a local file)"
env -i HOME="$H" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin TERM=dumb DINOBOT_ALLOW_UNSIGNED=1 DINOBOT_NAME="Mac Test" \
  DINOBOT_TARBALL="$DIR/dinobot-darwin-arm64.tar.gz" DINOBOT_LAUNCHD_LABEL="$LABEL" OPENROUTER_API_KEY=sk-or-fake-e2e \
  sh "$DIR/install.sh" --service launchd --port "$PORT" --answers '{"extras":"coordinator"}' 2>&1 \
  | sed -e 's/\x1b\[[0-9;]*m//g' | grep -v '█\|▀\|▄' | grep -v '^\s*$' | tee /tmp/dbt/install.log
step "install finished"
S=$H/.dinobot/state.json
test -f "$S" || { bad "no state.json"; exit 1; }
grep -q "Scan this with the DinoBot app" /tmp/dbt/install.log && ok "QR printed" || bad "QR"
PW=$(sed -n 's/^PASEO_PASSWORD=//p' "$H/.dinobot/daemon.env")
NODE=$H/.dinobot/app/node/bin/node
J() { "$NODE" -p "$1"; }
echo "== listen $(J "require('$S').listen"); short herdr sockets: $(J "require('$S').herdrSocketDir")"
for ep in $(J "require('$S').endpoints.join(' ')"); do
  t=$(ms)
  if out=$(env -i HOME="$H" PATH=/usr/bin:/bin PASEO_PASSWORD="$PW" "$H/.dinobot/bin/paseo" daemon status --host "$ep" --json 2>&1); then
    ok "$ep answers on the first try ($(( $(ms) - t )) ms)"
  else bad "$ep: $(echo "$out" | tr -d '\n' | grep -o '"message"[^}]*' | head -1 | cut -c1-200)"
    echo "     launchd daemon pid now: $(launchctl print "gui/$UIDN/$LABEL.daemon" | awk '/pid =|state =|runs =|last exit/{printf "%s ", $0}')"
    grep -E '"level":(40|50|60)|Server closed|exited' "$H/.dinobot/logs/daemon.log" | tail -4 | cut -c1-300
  fi
done
for l in daemon herdr herdr-gc; do launchctl print "gui/$UIDN/$LABEL.$l" >/dev/null 2>&1 && ok "launchd $LABEL.$l loaded" || bad "launchd $LABEL.$l"; done
if env -i HOME="$H" PATH=/usr/bin:/bin HERDR_SESSION=paseo-bots "$H/.dinobot/bin/herdr" agent list >/dev/null 2>&1; then ok "herdr session paseo-bots answers"; else bad "herdr session"; tail -3 "$H/.dinobot/logs/herdr.log"; fi
echo "== Mac load after install: $(uptime | sed 's/.*load averages*: //'); busiest: $(ps -Ao pcpu,comm -r | sed -n '2,4p' | awk '{printf "%s%% %s; ", $1, $2}')"
SL=$(env -i HOME="$H" PATH=/usr/bin:/bin HERDR_SESSION=paseo-bots "$H/.dinobot/bin/herdr" session list --json 2>&1)
echo "$SL" | grep -q '"name":"paseo-bots"[^}]*"running":true\|"running":true[^}]*"name":"paseo-bots"' && ok "herdr session list: paseo-bots running" || { bad "herdr session list: $SL"; }
echo "     herdr.log: $(head -c 400 "$H/.dinobot/logs/herdr.log" | tr '\n' ' ')"
# Isolation: nothing of this test may land in the real home (launchd agents get the account's HOME).
for p in "$HOME/.config/herdr/sessions/paseo-bots" "$HOME/bots/juniper" "$HOME/.optchat/profiles/juniper" "$HOME/.dinobot"; do
  [ -e "$p" ] && bad "test wrote into the real home: $p" || ok "real home untouched: ${p/#$HOME/~}"
done
grep -q 'Workers: separate herdr session "paseo-bots" running' /tmp/dbt/install.log && ok "setup saw the herdr session running" || bad "setup did not see herdr running"
step "doctor"
BW doctor | tee /tmp/dbt/doctor.txt; grep -q '^FAIL' /tmp/dbt/doctor.txt && bad "doctor" || ok "doctor: no FAIL"
step "update (same tarball)"
BW update --tarball "$DIR/dinobot-darwin-arm64.tar.gz" | tail -2
grep -E "Workers" /tmp/dbt/install.log
step "survives a crash: kill -9 the daemon, launchd restarts it"
pid=$(launchctl print "gui/$UIDN/$LABEL.daemon" | awk '/pid =/{print $3; exit}')
kill -9 "$pid" 2>/dev/null; t=$(ms)
for i in $(seq 1 60); do
  sleep 1
  np=$(launchctl print "gui/$UIDN/$LABEL.daemon" | awk '/pid =/{print $3; exit}')
  if [ -n "$np" ] && [ "$np" != "$pid" ] && BW status 2>/dev/null | grep -q 'daemon   ready'; then ok "restarted by launchd (pid $pid -> $np) and ready in $(( $(ms) - t )) ms"; break; fi
  [ $i = 60 ] && bad "not back within 60 s"
done
step "timings from state.json"
"$NODE" -e "const s=require('$S'); for (const t of s.timings) console.log(String((t.atMs/1000).toFixed(1)+'s').padStart(7), ('+'+(t.ms/1000).toFixed(1)+'s').padStart(8), t.step); console.log('total', (s.totalMs/1000).toFixed(1)+'s')"
[ $fails = 0 ] && echo "MAC E2E: PASS" || echo "MAC E2E: $fails failure(s)"
