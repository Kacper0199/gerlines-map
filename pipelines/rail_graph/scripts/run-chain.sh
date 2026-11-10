#!/usr/bin/env bash
# Runs an unattended rollover chain (a script of runbook section 2 steps) with the chain settings: the memory guards
# wait up to GUARD_WAIT_S (3600) seconds for the floor, run-pfaedle.sh retries once (GUARD_RETRIES 1), and on macOS
# the machine stays awake for the whole chain (caffeinate -dims; -s holds only on AC power, so keep it plugged in, lid open).
# Usage: run-chain.sh <command> [args...]      e.g. run-chain.sh bash data/rail_graph/chain-2026-11-09.sh
# Values already set in the environment win. Exits with the command's status.
set -euo pipefail
(($# > 0)) || {
  echo "usage: run-chain.sh <command> [args...]" >&2
  exit 2
}
export GUARD_WAIT_S="${GUARD_WAIT_S:-3600}" GUARD_RETRIES="${GUARD_RETRIES:-1}"
echo "chain: GUARD_WAIT_S=$GUARD_WAIT_S GUARD_RETRIES=$GUARD_RETRIES, started $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dims "$@"
fi
echo "chain: caffeinate not found, the machine may sleep" >&2
exec "$@"
