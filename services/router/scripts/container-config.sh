#!/usr/bin/env bash
# Writes runs/<run>/container.yml: the run's imported config with the server bound to 0.0.0.0:8080 and the web folder
# of the image, for the compose service router, which mounts it over /data/config.yml (the data dir stays read-only).
# Usage: container-config.sh <run>
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run="${1:-}"
[[ -n "$run" ]] || die "usage: container-config.sh <run>"
run_dir="$ROUTER_DATA/runs/$run"
source_config="$run_dir/data/config.import.yml"
[[ -f "$source_config" ]] || source_config="$run_dir/data/config.yml"
[[ -f "$source_config" ]] || die "no imported run at $run_dir"
grep -q '^ *rt:' "$source_config" && die "$source_config carries a realtime feed, run stop.sh $run first"

awk '
  /^server:/ {in_server = 1; print; next}
  /^[^ ]/ {in_server = 0}
  in_server && $1 == "host:" {print "  host: 0.0.0.0"; next}
  in_server && $1 == "port:" {print "  port: 8080"; next}
  in_server && $1 == "web_folder:" {print "  web_folder: /opt/motis/ui"; next}
  {print}
' "$source_config" >"$run_dir/container.yml"
grep -q '^  host: 0.0.0.0$' "$run_dir/container.yml" || die "no server host in $source_config"
echo "wrote $run_dir/container.yml"
