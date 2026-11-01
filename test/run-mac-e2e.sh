#!/bin/bash
# From the build host: copy the darwin-arm64 tarball, install.sh and e2e-mac.sh to the Mac (/tmp/dbt-pkg) and run it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
PKG=/tmp/dbt-pkg
ssh mac "rm -rf $PKG && mkdir -p $PKG"
t=$(node -e "console.log(Date.now())")
scp -q "$HERE/dist/dinobot-darwin-arm64.tar.gz" "$HERE/dist/dinobot-darwin-arm64.tar.gz.sha256" "$HERE/dist/install.sh" "$HERE/test/e2e-mac.sh" "mac:$PKG/"
echo "== copied to the Mac in $(( $(node -e "console.log(Date.now())") - t )) ms"
ssh mac "bash $PKG/e2e-mac.sh $PKG"
