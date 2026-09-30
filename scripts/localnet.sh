#!/usr/bin/env bash
# Starts a local Solana node with everything Aegis depends on, at their mainnet addresses:
#
#   - Upside Access Control and Transfer Restrictions
#   - Meteora Dynamic Bonding Curve and DAMM v2
#   - the Meteora-owned DAMM v2 config accounts that migration reads
#
# These are the same mainnet binaries and accounts the test suite runs against, so behaviour
# matches. Aegis itself is not preloaded: `scripts/localnet-deploy.sh` deploys it for real.
#
# Runs in the foreground; stop it with Ctrl+C. State lives in .localnet/ and is wiped on start.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=.localnet
rm -rf "$DIR"
mkdir -p "$DIR/accounts"

# The DAMM v2 configs are stored as one JSON map for the tests. solana-test-validator wants one
# file per account, in the shape `solana account --output json` produces.
node -e '
const fs = require("fs");
const configs = JSON.parse(fs.readFileSync("tests/fixtures/damm_v2_configs.json", "utf8"));
for (const [pubkey, a] of Object.entries(configs)) {
  const data = Buffer.from(a.data, "base64");
  fs.writeFileSync(`.localnet/accounts/${pubkey}.json`, JSON.stringify({
    pubkey,
    account: {
      lamports: a.lamports,
      data: [a.data, "base64"],
      owner: a.owner,
      executable: a.executable,
      rentEpoch: 0,
      space: data.length,
    },
  }));
}
'

ACCOUNTS=()
for f in "$DIR"/accounts/*.json; do
  ACCOUNTS+=(--account "$(basename "$f" .json)" "$f")
done

echo "Starting local validator at http://127.0.0.1:8899 (Ctrl+C to stop)"
exec solana-test-validator \
  --reset \
  --quiet \
  --ledger "$DIR/ledger" \
  --bpf-program 4X79YRjz9KNMhdjdxXg2ZNTS3YnMGYdwJkBHnezMJwr3 programs/aegis/tests/fixtures/access_control.so \
  --bpf-program 6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ programs/aegis/tests/fixtures/transfer_restrictions.so \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN programs/aegis/tests/fixtures/meteora_dbc.so \
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG tests/fixtures/damm_v2.so \
  "${ACCOUNTS[@]}"
