#!/usr/bin/env bash
# Scans the staged content (the index, not the working tree) for secrets with secretlint. Offline.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
secretlint="$repo_root/node_modules/.bin/secretlint"
if [[ ! -x "$secretlint" ]]; then
  echo "scan-staged-secrets: secretlint not found, run pnpm install first" >&2
  exit 1
fi

staged_copy="$(mktemp -d "${TMPDIR:-/tmp}/gerlines-staged.XXXXXX")"
trap 'rm -rf "$staged_copy"' EXIT

key_files="$(git -C "$repo_root" diff --cached --name-only --diff-filter=ACMR | grep -iE '\.(p12|pfx)$' || true)"
if [[ -n "$key_files" ]]; then
  echo "scan-staged-secrets: refusing staged certificate bundles:" >&2
  echo "$key_files" >&2
  exit 1
fi

git -C "$repo_root" diff --cached --name-only --diff-filter=ACMR -z \
  | git -C "$repo_root" checkout-index --prefix="$staged_copy/" -z --stdin

if [[ -z "$(find "$staged_copy" -type f -print -quit)" ]]; then
  exit 0
fi

cd "$staged_copy"
find . -type f -print0 \
  | xargs -0 "$secretlint" --secretlintrc "$repo_root/.secretlintrc.json" --no-glob --no-gitignore --
