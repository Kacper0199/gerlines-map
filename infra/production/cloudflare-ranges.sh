#!/usr/bin/env bash
# The Cloudflare edge ranges of cloudflare-ips.txt in the forms the production stack reads.
#   env      print CLOUDFLARE_RANGES (space separated, for Caddy) and API_CLOUDFLARE_RANGES (comma separated, for
#            the API) as env file lines, to append to the production env file
#   refresh  fetch https://www.cloudflare.com/ips-v4 and ips-v6 and rewrite cloudflare-ips.txt when they changed
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
list="$here/cloudflare-ips.txt"

ranges() {
  grep -v -e '^#' -e '^[[:space:]]*$' "$list"
}

case "${1:-env}" in
  env)
    printf 'CLOUDFLARE_RANGES=%s\n' "$(ranges | paste -sd ' ' -)"
    printf 'API_CLOUDFLARE_RANGES=%s\n' "$(ranges | paste -sd ',' -)"
    ;;
  refresh)
    fetched="$(mktemp)"
    trap 'rm -f "$fetched"' EXIT
    for family in v4 v6; do
      curl --fail --silent --show-error --max-time 20 "https://www.cloudflare.com/ips-$family"
      echo
    done | grep -E '^[0-9a-f.:]+/[0-9]+$' >"$fetched"
    if [[ $(grep -c . "$fetched") -lt 10 ]]; then
      echo "refresh: the fetched lists hold fewer than 10 ranges, keeping $list" >&2
      exit 1
    fi
    if diff -q <(ranges | sort) <(sort "$fetched") >/dev/null; then
      echo "refresh: unchanged"
      exit 0
    fi
    {
      printf '# Cloudflare edge ranges from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, read %s.\n' "$(date -u +%F)"
      printf '# One CIDR per line. Refresh with: bash infra/production/cloudflare-ranges.sh refresh\n'
      cat "$fetched"
    } >"$list"
    echo "refresh: $list rewritten; update CLOUDFLARE_RANGES and API_CLOUDFLARE_RANGES (env), the firewall and restart edge and api"
    ;;
  *)
    echo "usage: $0 [env|refresh]" >&2
    exit 2
    ;;
esac
