#!/usr/bin/env bash
# Starts a fresh local node, deploys Aegis, runs a complete launch against it, and ALWAYS stops the
# node afterwards — whether the run succeeds, fails, or is interrupted with Ctrl+C.
#
#   yarn localnet:e2e
#
# Run `anchor build` first: this deploys whatever is in target/deploy/.
set -euo pipefail
cd "$(dirname "$0")/.."

URL=http://127.0.0.1:8899
VALIDATOR_PID=""
LOG=$(mktemp -t aegis-validator)

stop_validator() {
  if [ -n "$VALIDATOR_PID" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "Stopping the local node (pid $VALIDATOR_PID) ..."
    kill "$VALIDATOR_PID" 2>/dev/null || true
    # Give it ten seconds to shut down cleanly, then force it.
    for _ in $(seq 1 20); do
      kill -0 "$VALIDATOR_PID" 2>/dev/null || break
      perl -e 'select(undef, undef, undef, 0.5)'
    done
    kill -9 "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  VALIDATOR_PID=""
  if lsof -i :8899 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WARNING: something is still listening on port 8899." >&2
  else
    echo "Local node stopped. Nothing is left running."
  fi
}

on_exit() {
  status=$?
  stop_validator
  if [ "$status" -ne 0 ]; then
    echo "Run failed. Validator log kept at $LOG" >&2
  else
    rm -f "$LOG"
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

if lsof -i :8899 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 8899 is already in use — another node is running. Stop it first." >&2
  exit 1
fi

# localnet.sh ends in `exec solana-test-validator`, so this PID is the validator itself.
./scripts/localnet.sh >"$LOG" 2>&1 &
VALIDATOR_PID=$!

echo "Waiting for the local node ..."
for _ in $(seq 1 60); do
  solana cluster-version -u "$URL" >/dev/null 2>&1 && break
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "The local node exited during start-up:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  perl -e 'select(undef, undef, undef, 1)'
done
solana cluster-version -u "$URL" >/dev/null 2>&1 || { echo "The local node did not start in 60s." >&2; exit 1; }

./scripts/localnet-deploy.sh
npx ts-node scripts/localnet-launch.ts
