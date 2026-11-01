#!/usr/bin/env bash
# End-to-end: install from the built tarball into a throwaway HOME under ~/scratch (never the live
# setup), over HTTP like a real download, then check the daemon answers on every offered endpoint
# with the password from the QR (and refuses a wrong one), the herdr session runs, and time it.
#
#   test/e2e-temp-home.sh found|nosignin|tty|longhome|lan   (KEEP=1 keeps the temp HOME)
#
# Scenarios: found    = an API key in the environment (no sign-in question)
#            nosignin = nothing found; the sign-in question is answered (API key), so Q1 is asked
#            tty      = answers typed through a real pty
#            longhome = like found, with a 90-character HOME (herdr short sockets)
#            notailscale = Tailscale installed but stopped (fake CLI): setup must stop with the
#                       steps, exit 2, and start nothing (Tailscale is required; no LAN mode)
# Every scenario also: first connection right after setup must succeed (no retry), doctor,
# and `update` (same tarball = no-op; UPDATE=1 also installs a changed tarball and checks it).
# E2E_PORT (default 6791) keeps clear of 6767/6808/6809.
set -euo pipefail
SCENARIO=${1:-found}
HERE=$(cd "$(dirname "$0")/.." && pwd)
PRODUCT_ID=$(node -p "require('$HERE/lib/product.json').id")
PRODUCT_NAME=$(node -p "require('$HERE/lib/product.json').name")
E2E=$(cd "$HERE/.." && pwd)/e2e/${SCENARIO}
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; *) ARCH=arm64 ;; esac
TAR=$HERE/dist/$PRODUCT_ID-$(uname -s | tr '[:upper:]' '[:lower:]')-$ARCH.tar.gz
test -f "$TAR" || { echo "no $TAR: run build/build-tarball.sh"; exit 1; }
rm -rf "$E2E"; mkdir -p "$E2E"
HOMEDIR=$E2E/home
if [ "$SCENARIO" = longhome ]; then
  HOMEDIR=$E2E/h; while [ ${#HOMEDIR} -lt 90 ]; do HOMEDIR=${HOMEDIR}x; done
  echo "== HOME is ${#HOMEDIR} characters: $HOMEDIR"
fi
mkdir -p "$HOMEDIR"
E2E_PORT=${E2E_PORT:-6791}

SRV_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
mkdir -p "$E2E/www"; ln -sf "$TAR" "$TAR.sha256" "$E2E/www/"
# The .tar.zst too when the build made one (install.sh takes it where zstd is installed; FORMAT=gz
# serves only the .tar.gz, the route of a computer without zstd).
ZTAR=${TAR%.gz}.zst
[ "${FORMAT:-}" != gz ] && [ -f "$ZTAR" ] && ln -sf "$ZTAR" "$ZTAR.sha256" "$E2E/www/"
python3 -m http.server "$SRV_PORT" --bind 127.0.0.1 --directory "$E2E/www" >"$E2E/http.log" 2>&1 &
SRV=$!
cleanup() {
  HSD=$(node -p "require('$HOMEDIR/.$PRODUCT_ID/state.json').herdrSocketDir || ''" 2>/dev/null || true)
  env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin "$HOMEDIR/.$PRODUCT_ID/bin/$PRODUCT_ID" stop >/dev/null 2>&1 || true
  [ -n "$HSD" ] && rm -rf "$HSD"
  kill "$SRV" 2>/dev/null || true
  # Belt and braces: anything still running from the temp HOME.
  pkill -f "$HOMEDIR/.$PRODUCT_ID/" 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] || rm -rf "$HOMEDIR" "$E2E/www" "$E2E/upd"
}
trap cleanup EXIT
sleep 0.3

BASE_ENV=(HOME="$HOMEDIR" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin TERM=dumb DINOBOT_ALLOW_UNSIGNED=1 DINOBOT_NAME="Test User" DINOBOT_BASE_URL="http://127.0.0.1:$SRV_PORT" ${XDG_RUNTIME_DIR:+XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR})
FLAGS=(--service none --port "$E2E_PORT")
case "$SCENARIO" in
  found|longhome) EXTRA_ENV=(OPENROUTER_API_KEY=sk-or-fake-e2e); ANSWERS='{"extras":"coordinator"}' ;;
  notailscale)
    mkdir -p "$E2E/fakebin"; printf '#!/bin/sh\necho %s\nexit 1\n' "'{\"BackendState\":\"Stopped\",\"Self\":{}}'" >"$E2E/fakebin/tailscale"; chmod +x "$E2E/fakebin/tailscale"
    EXTRA_ENV=(OPENROUTER_API_KEY=sk-or-fake-e2e DINOBOT_TAILSCALE_BIN="$E2E/fakebin/tailscale"); ANSWERS='{"extras":"coordinator"}' ;;
  nosignin) EXTRA_ENV=(); ANSWERS='{"signin":"openrouter:api-key:2","key:openrouter":"sk-or-fake-e2e","extras":"coordinator"}' ;;
  tty) EXTRA_ENV=(); ANSWERS='' ;; # real terminal: typed answers through a pty (script(1))
  *) echo "scenario?" >&2; exit 2 ;;
esac

echo "== install ($SCENARIO) from $(basename "$TAR") ($(du -h "$TAR" | cut -f1)) over http://127.0.0.1:$SRV_PORT"
now_ms() { node -e "console.log(Date.now())"; }
START=$(now_ms)
if [ "$SCENARIO" = tty ]; then
  # Typed like a user: name (Enter keeps the default... here a new name), sign-in 3 = OpenRouter key,
  # the key, then Enter on the extras checklist. Sleeps stand in for reading time.
  BASE_ENV=("${BASE_ENV[@]/DINOBOT_NAME=Test User/DINOBOT_NAME=}")
  { sleep 1; echo "Test User"; sleep 9; echo 3; sleep 1; echo sk-or-fake-e2e; sleep 3; echo; sleep 30; } |
    env -i "${BASE_ENV[@]}" script -qefc "sh '$HERE/dist/install.sh' ${FLAGS[*]}" /dev/null 2>&1
else
  env -i "${BASE_ENV[@]}" "${EXTRA_ENV[@]}" sh "$HERE/dist/install.sh" "${FLAGS[@]}" --answers "$ANSWERS" 2>&1
fi | tee "$E2E/install.log" | grep -v '^\s*$' | sed -e 's/\x1b\[[0-9;]*m//g' | grep -v '█\|▀\|▄' || true
END=$(now_ms)
echo "== install wall time: $(( (END - START) )) ms"

if [ "$SCENARIO" = notailscale ]; then
  f=0
  grep -q "Tailscale is installed but off" "$E2E/install.log" && echo "ok   setup stopped with the Tailscale steps" || { echo "FAIL no Tailscale steps"; f=1; }
  grep -q "Then finish setup:.*setup --name" "$E2E/install.log" && echo "ok   steps end with the re-run command" || { echo "FAIL no re-run command"; f=1; }
  test -x "$HOMEDIR/.$PRODUCT_ID/bin/$PRODUCT_ID" && echo "ok   the re-run command exists" || { echo "FAIL no wrapper"; f=1; }
  test -f "$HOMEDIR/.$PRODUCT_ID/state.json" && { echo "FAIL setup went on"; f=1; } || echo "ok   nothing set up"
  ss -ltn 2>/dev/null | grep -q ":$E2E_PORT " && { echo "FAIL something listens on $E2E_PORT"; f=1; } || echo "ok   nothing listening on $E2E_PORT"
  pgrep -f "$HOMEDIR/.$PRODUCT_ID/" >/dev/null && { echo "FAIL processes started"; f=1; } || echo "ok   no processes started"
  [ $f = 0 ] && echo "E2E notailscale: PASS" || { echo "E2E notailscale: FAIL"; exit 1; }
  exit 0
fi
STATE=$HOMEDIR/.$PRODUCT_ID/state.json
test -f "$STATE" || { echo "FAIL: no state.json"; exit 1; }

PORT=$(node -p "require('$STATE').port")
PW=$(sed -n 's/^PASEO_PASSWORD=//p' "$HOMEDIR/.$PRODUCT_ID/daemon.env")
echo "== questions in this flow: $(node -p "JSON.stringify(require('$STATE').questions)") (answers preset by the test)"
grep -q "Scan this with the $PRODUCT_NAME app" "$E2E/install.log" && echo "ok   QR printed (\"$PRODUCT_NAME\")" || { echo "FAIL QR"; exit 1; }
grep -q "bin/dinobot pair --link" "$E2E/install.log" && echo "ok   desktop pairing line printed" || { echo "FAIL desktop pairing line"; exit 1; }
echo "== listen $(node -p "require('$STATE').listen") ($(node -p "require('$STATE').listenScope")); endpoints $(node -p "require('$STATE').endpoints.join(' ')")"

PASEO="$HOMEDIR/.$PRODUCT_ID/bin/paseo"
fails=0
for ep in $(node -p "require('$STATE').endpoints.join(' ')"); do
  host=${ep%:*}
  case "$host" in *.local) getent hosts "$host" >/dev/null || { echo "skip $ep (no mDNS resolver on this host)"; continue; } ;; esac
  t0=$(now_ms)
  st() { env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin PASEO_PASSWORD="$PW" "$PASEO" daemon status --host "$1" --json 2>&1; }
  # No retry: the QR is only shown once the daemon accepts clients, so the first try must work.
  if out=$(st "$ep"); then
    echo "ok   $ep answers on the first try ($(( $(now_ms) - t0 )) ms incl. CLI start)"
  else
    echo "FAIL $ep on the first try: $(echo "$out" | tr -d '\n' | grep -o '"message"[^}]*' | head -1 | cut -c1-200)"; fails=$((fails + 1))
  fi
done
FIRST=$(node -p "require('$STATE').endpoints[0]")
if env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin PASEO_PASSWORD=wrong "$PASEO" daemon status --host "$FIRST" --json >/dev/null 2>&1; then
  echo "FAIL wrong password accepted"; fails=$((fails + 1))
else
  echo "ok   wrong password refused"
fi

BW=(env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin DINOBOT_ALLOW_UNSIGNED=1 ${XDG_RUNTIME_DIR:+XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR} OPENROUTER_API_KEY=sk-or-fake-e2e "$HOMEDIR/.$PRODUCT_ID/bin/$PRODUCT_ID")
"${BW[@]}" status
HS=$(node -p "require('$STATE').herdrSocketDir || ''")
[ "$SCENARIO" = longhome ] && { [ -n "$HS" ] && echo "ok   herdr short sockets in $HS" || { echo "FAIL no short herdr sockets for a long HOME"; fails=$((fails + 1)); }; }
if env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin HERDR_SESSION=paseo-bots "$HOMEDIR/.$PRODUCT_ID/bin/herdr" agent list >/dev/null 2>&1; then echo "ok   herdr session paseo-bots answers"; else echo "FAIL herdr session"; fails=$((fails + 1)); fi
# What the bots plugin reads: session list must report our session running with a socket that answers.
SL=$(env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin HERDR_SESSION=paseo-bots "$HOMEDIR/.$PRODUCT_ID/bin/herdr" session list --json)
node -e "const s=JSON.parse(process.argv[1]).sessions.find(x=>x.name==='paseo-bots'); if(!s?.running) process.exit(1)" "$SL" && echo "ok   herdr session list: paseo-bots running ($(node -p "JSON.parse(process.argv[1]).sessions.find(x=>x.name==='paseo-bots').socket_path" "$SL"))" || { echo "FAIL session list: $SL"; fails=$((fails + 1)); }

# A bot posting into a group (bot-room) and DMing (bot-dm) from the daemon's environment: they load
# the bundled daemon's CLI internals (PASEO_CLI_DIST), not ~/.local/lib/node_modules (visual-bugs 1:
# "cannot load .../@getpaseo/cli/dist/utils/client.js"). The group and agent are made up, so the
# daemon's answer is a refusal (exit 3); reaching it proves the load and the connection worked.
BOT_ENV=(env -i); while IFS= read -r l; do [ -n "$l" ] && BOT_ENV+=("$l"); done <"$HOMEDIR/.$PRODUCT_ID/daemon.env"
BOT_ENV+=(PASEO_AGENT_ID=e2e-no-such-agent)
set +e
BR=$("${BOT_ENV[@]}" "$HOMEDIR/.$PRODUCT_ID/bin/bot-room" post e2e-no-such-group --re e2e-1 --text "e2e" 2>&1); BRC=$?
set -e
if [ "$BRC" = 3 ] && echo "$BR" | grep -q '"ok":false'; then echo "ok   bot-room post reaches the daemon from a bot's env (refused: $(echo "$BR" | grep -o '"code":"[^"]*"' | head -1))"
else echo "FAIL bot-room post (exit $BRC): $(echo "$BR" | tr '\n' ' ' | cut -c1-300)"; fails=$((fails + 1)); fi
set +e
BD=$("${BOT_ENV[@]}" "$HOMEDIR/.$PRODUCT_ID/bin/bot-dm" juniper --text "e2e" 2>&1); BDC=$?
set -e
# Unknown agent id: bot-dm lists the daemon's agents, then refuses the sender ("is not a bot").
echo "$BD" | grep -q 'is not a bot' && echo "ok   bot-dm reaches the daemon from a bot's env (sender refused, exit $BDC)" || { echo "FAIL bot-dm (exit $BDC): $(echo "$BD" | tr '\n' ' ' | cut -c1-300)"; fails=$((fails + 1)); }

# One sign-in for daemon, bots and herdr workers: DinoBot's own pi dir; ~/.pi untouched.
test -f "$HOMEDIR/.$PRODUCT_ID/pi/auth.json" && echo "ok   sign-in saved in ~/.$PRODUCT_ID/pi" || { echo "FAIL no auth in own pi dir"; fails=$((fails + 1)); }
test -e "$HOMEDIR/.pi" && { echo "FAIL ~/.pi was created"; fails=$((fails + 1)); } || echo "ok   ~/.pi not touched"
test -L "$HOMEDIR/.$PRODUCT_ID/pi/npm/node_modules/pi-web-access" && grep -q 'npm:pi-web-access' "$HOMEDIR/.$PRODUCT_ID/pi/settings.json" && echo "ok   pi-web-access installed for DinoBot's pi" || { echo "FAIL pi-web-access"; fails=$((fails + 1)); }
HP=$(pgrep -f "$HOMEDIR/.$PRODUCT_ID/app/herdr/herdr server" | head -1)
[ -n "$HP" ] && tr '\0' '\n' </proc/$HP/environ | grep -q "^PI_CODING_AGENT_DIR=$HOMEDIR/.$PRODUCT_ID/pi$" && echo "ok   herdr server (workers) uses the same pi dir" || { echo "FAIL herdr env PI_CODING_AGENT_DIR"; fails=$((fails + 1)); }
grep -q 'Workers: separate herdr session "paseo-bots" running' "$E2E/install.log" && echo "ok   setup saw the herdr session running" || { echo "FAIL setup did not see herdr running"; fails=$((fails + 1)); }
echo "== doctor"
"${BW[@]}" doctor | tee "$E2E/doctor.txt" || true
grep -q '^FAIL' "$E2E/doctor.txt" && { echo "FAIL doctor reported problems"; fails=$((fails + 1)); } || echo "ok   doctor: no FAIL"

echo "== update (same tarball)"
"${BW[@]}" update | tee "$E2E/update-same.txt"
echo "   installed from $(node -p "require('$HOMEDIR/.$PRODUCT_ID/state.json').tarballFormat" 2>/dev/null) archive"
grep -q 'already up to date' "$E2E/update-same.txt" && echo "ok   update: same build is a no-op" || { echo "FAIL update no-op"; fails=$((fails + 1)); }
if [ "${UPDATE:-0}" = 1 ]; then
  echo "== update (changed tarball)"
  rm -rf "$E2E/upd"; mkdir -p "$E2E/upd"; tar -xzf "$TAR" -C "$E2E/upd"
  d=$(ls "$E2E/upd"); node -e "const f='$E2E/upd/$d/MANIFEST.json',m=require(f);m.built='e2e-update';require('fs').writeFileSync(f,JSON.stringify(m))"
  tar -C "$E2E/upd" -czf "$E2E/www/u.tar.gz" "$d"; rm -rf "$E2E/upd"
  uv=$("${BW[@]}" update --url "http://127.0.0.1:$SRV_PORT/u.tar.gz" 2>&1 || true)
  grep -q "e2e-update" "$HOMEDIR/.$PRODUCT_ID/app/MANIFEST.json" && { echo "FAIL unverified update was installed"; fails=$((fails + 1)); }
  # (ff0690f: a .sha256 that 404s is reported as "no release published", still refused.)
  echo "$uv" | grep -Eq "cannot be verified|No release has been published" && echo "ok   update without a checksum refused (fail closed)" || { echo "FAIL update without checksum: $uv"; fails=$((fails + 1)); }
  (cd "$E2E/www" && sha256sum u.tar.gz >u.tar.gz.sha256)
  t0=$(now_ms)
  "${BW[@]}" update --url "http://127.0.0.1:$SRV_PORT/u.tar.gz" | tee "$E2E/update.txt"
  echo "   update took $(( $(now_ms) - t0 )) ms"
  grep -q 'e2e-update' "$HOMEDIR/.$PRODUCT_ID/app/MANIFEST.json" && echo "ok   update swapped the app" || { echo "FAIL update swap"; fails=$((fails + 1)); }
  if env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin PASEO_PASSWORD="$PW" "$PASEO" daemon status --host "$FIRST" --json >/dev/null 2>&1; then echo "ok   daemon answers after update (same password)"; else echo "FAIL daemon after update"; fails=$((fails + 1)); fi
fi
test -f "$HOMEDIR/bots/juniper/.optchat-profile" && echo "ok   starter bot juniper" || { echo "FAIL starter bot"; fails=$((fails + 1)); }
# The installer's model pick is the host default, so the phone's "Choose models" may move it (setup: true).
node -e "const m=require('$HOMEDIR/bots/juniper/.bot.json'); if(!m.chat || m.chat.setup!==true) process.exit(1)" && echo "ok   starter bot model is the host default (setup: true), so Choose models moves it" || { echo "FAIL starter bot model marked as the user's own pick"; fails=$((fails + 1)); }
node -e "const s=require('$HOMEDIR/bots/.settings.json'); if(s.user.name!=='Test User'||s.escalation!=='juniper'||!s.defaultModel) process.exit(1)" && echo "ok   settings (name, escalation, default model)" || { echo "FAIL settings"; fails=$((fails + 1)); }
if grep -rq -e '/code/' "$HOMEDIR/.$PRODUCT_ID/paseo/config.json" "$HOMEDIR/bots/.settings.json" \
  || ! sh "$HERE/build/private-guard.sh" "$HOMEDIR/.$PRODUCT_ID/paseo/config.json" >/dev/null 2>&1 \
  || ! sh "$HERE/build/private-guard.sh" "$HOMEDIR/bots/.settings.json" >/dev/null 2>&1; then
  echo "FAIL dev path or private name in config"; fails=$((fails + 1))
else echo "ok   no ~/code paths or private names in config"; fi
sleep 3
grep -i -m3 'bots\b.*\(loaded\|error\)\|plugin.*bots' "$HOMEDIR/.$PRODUCT_ID/logs/daemon.log" | cut -c1-200 || true

echo "== timings"
node -e "
const s=require('$STATE');
for (const t of s.timings) console.log(String((t.atMs/1000).toFixed(1)+'s').padStart(7), ('+'+(t.ms/1000).toFixed(1)+'s').padStart(8), t.step);
console.log('total', (s.totalMs/1000).toFixed(1)+'s');
" | tee "$E2E/timings.txt"
cp "$STATE" "$E2E/state.json"
[ "$fails" = 0 ] && echo "E2E $SCENARIO: PASS" || { echo "E2E $SCENARIO: $fails failure(s)"; exit 1; }
