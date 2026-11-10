#!/usr/bin/env bash
# Runs docker compose for the local stack, reading the root .env for interpolation when it exists.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
args=(--file "$repo_root/infra/compose.yaml")
if [[ -f "$repo_root/.env" ]]; then
  args+=(--env-file "$repo_root/.env")
fi

exec docker compose "${args[@]}" "$@"
