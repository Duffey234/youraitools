#!/usr/bin/env bash
# Daily refresh: rebuild the bundled OFAC SDN snapshot from the official Treasury files; if the address set or list
# date changed, regenerate examples, run the tests and redeploy the Worker, then commit locally.
# Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment (never printed). Safe to run repeatedly.
#   bash scripts/refresh.sh            # build + deploy if changed
#   bash scripts/refresh.sh --dry-run  # build + test only
set -euo pipefail
cd "$(dirname "$0")/.."
before=$(sha256sum src/data/sdn.js | cut -d' ' -f1)
cp src/data/sdn.js /tmp/payguard-sdn.prev.js
python3 scripts/build-sdn.py --out /tmp/payguard-sdn.new.js
# Compare ignoring generated_at
strip() { sed -E 's/"generated_at":"[^"]*",//' "$1" | sha256sum | cut -d' ' -f1; }
if [ "$(strip /tmp/payguard-sdn.new.js)" = "$(strip src/data/sdn.js)" ]; then echo "SDN unchanged"; exit 0; fi
# Guard against a truncated / broken download: never shrink the list by more than 10% automatically
old=$(grep -o '"address_count":[0-9]*' src/data/sdn.js | cut -d: -f2); new=$(grep -o '"address_count":[0-9]*' /tmp/payguard-sdn.new.js | cut -d: -f2)
if [ "$new" -lt $(( old * 9 / 10 )) ]; then echo "refusing: address count dropped $old -> $new"; exit 1; fi
cp /tmp/payguard-sdn.new.js src/data/sdn.js
node scripts/build-lite.mjs
node scripts/gen-examples.mjs
if ! npm test >/tmp/payguard-refresh-test.log 2>&1; then cp /tmp/payguard-sdn.prev.js src/data/sdn.js; node scripts/build-lite.mjs; node scripts/gen-examples.mjs; echo "tests failed; reverted (see /tmp/payguard-refresh-test.log)"; exit 1; fi
[ "${1:-}" = "--dry-run" ] && { echo "dry run: $old -> $new addresses"; exit 0; }
npx wrangler deploy >/tmp/payguard-refresh-deploy.log 2>&1
pub=$(grep -o '"publish_date":"[^"]*"' src/data/sdn.js | cut -d'"' -f4)
git add src/data/sdn.js src/data/sdn-lite.js src/examples.js && git commit -q -m "SDN refresh: list $pub, $new addresses (was $old)"
echo "deployed: list $pub, $old -> $new addresses"
