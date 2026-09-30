#!/usr/bin/env bash
# Deploys both Aegis programs to the local node started by scripts/localnet.sh.
#
# Uses a throwaway deployer keypair in .localnet/, never your own wallet. Run `anchor build`
# first: this deploys whatever is in target/deploy/.
set -euo pipefail
cd "$(dirname "$0")/.."

URL=http://127.0.0.1:8899
DEPLOYER=.localnet/deployer.json

solana cluster-version -u "$URL" >/dev/null 2>&1 || {
  echo "No local node at $URL. Start one with scripts/localnet.sh first." >&2
  exit 1
}

[ -f "$DEPLOYER" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$DEPLOYER"
solana airdrop 100 "$(solana-keygen pubkey "$DEPLOYER")" -u "$URL" >/dev/null

# Meteora's migration pays the new pool's rent out of its global pool-authority account and is
# reimbursed afterwards, so that account must already hold SOL. On mainnet and devnet it always
# does; a fresh local node starts it at zero.
POOL_AUTHORITY=$(node -e '
const { PublicKey } = require("@solana/web3.js");
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_authority")],
  new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")
);
console.log(pda.toBase58());
')
solana airdrop 5 "$POOL_AUTHORITY" -u "$URL" >/dev/null

for program in aegis aegis_hook; do
  echo "Deploying $program ..."
  solana program deploy "target/deploy/$program.so" \
    --program-id "target/deploy/$program-keypair.json" \
    --keypair "$DEPLOYER" \
    -u "$URL"
done
