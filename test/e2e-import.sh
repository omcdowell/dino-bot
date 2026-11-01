#!/usr/bin/env bash
# Chat import step: a fake HOME with one history per agent (rel-import's fixture), setup with the
# import ticked, staging only (DINOBOT_IMPORT_RUN=0: no model calls). Checks the estimate and the
# warning were offered and the import is staged in the starter bot's profile.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
FIX=${FIXTURE:-$HOME/scratch/rel-import/pi-optchat/test/fixtures/fake-home.ts}
E2E=$(cd "$HERE/.." && pwd)/e2e/i
rm -rf "$E2E"; mkdir -p "$E2E/home"; H=$E2E/home
trap 'env -i HOME="$H" PATH=/usr/bin:/bin "$H/.dinobot/bin/dinobot" stop >/dev/null 2>&1 || true; pkill -f "$H/.dinobot/" || true; [ "${KEEP:-0}" = 1 ] || rm -rf "$E2E"' EXIT
node --experimental-transform-types --no-warnings -e "import('$FIX').then(m => m.fakeHome('$H'))"
env -i HOME="$H" USER="$USER" PATH=/usr/bin:/bin DINOBOT_ALLOW_UNSIGNED=1 DINOBOT_NAME=Imp OPENROUTER_API_KEY=sk-or-fake DINOBOT_IMPORT_RUN=0 \
  DINOBOT_TARBALL="$(ls "$HERE"/dist/dinobot-*.tar.gz | head -1)" \
  sh "$HERE/install.sh" --service none --answers '{"extras":"coordinator,import"}' 2>&1 | grep -v '█\|▀\|▄' | grep -i -e import -e messages -e 'scan past' -e extras || true
S=$(env -i HOME="$H" PATH=/usr/bin:/bin OPTCHAT_HOME="$H/.optchat" "$H/.dinobot/bin/dinobot" import-status)
echo "import-status: $(echo "$S" | tr -d '\n' | cut -c1-200)"
echo "$S" | grep -q '"status"' && echo "E2E import: PASS" || { echo "E2E import: FAIL"; exit 1; }
