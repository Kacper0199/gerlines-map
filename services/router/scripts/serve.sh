#!/usr/bin/env bash
# Starts `motis server` for an imported run in the background and waits for /api/v1/health.
# Usage: serve.sh <run>        e.g. serve.sh rail-d49
# The port and every import setting come from the run's own config.yml (written by import.sh).
# Env: RT_URL (optional GTFS-RT feed for the run's dataset) with USER_AGENT, or APP_NAME and APP_CONTACT, taken from the
# process environment (this script never reads .env; see README), HEALTH_TIMEOUT_S (default 600).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run="${1:-}"
[[ -n "$run" ]] || die "usage: serve.sh <run>"
run_dir="$ROUTER_DATA/runs/$run"
run_config="$run_dir/config.yml"
[[ -f "$run_dir/data/config.yml" && -f "$run_config" ]] || die "no imported run at $run_dir"
port="$(awk -F'"' '$1 ~ /^  port: / {print $2; exit}' "$run_config")"
[[ -n "$port" ]] || die "no server port in $run_config"
pid_file="$run_dir/server.pid"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  die "server already running with pid $(cat "$pid_file"), run stop.sh $run"
fi

if curl --silent --max-time 2 --output /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
  die "port $port already answers (another server, perhaps another run): stop it or give $run its own port"
fi
[[ -f "$run_dir/data/config.import.yml" ]] || cp "$run_dir/data/config.yml" "$run_dir/data/config.import.yml"
if [[ -n "${RT_URL:-}" ]]; then
  if [[ -z "${USER_AGENT:-}" ]]; then
    [[ -n "${APP_NAME:-}" && -n "${APP_CONTACT:-}" ]] ||
      die "RT_URL needs USER_AGENT, or APP_NAME and APP_CONTACT, in the environment (see README)"
    version="$(awk -F'"' '/"version"/ {print $4; exit}' "$REPO_ROOT/package.json")"
    USER_AGENT="$APP_NAME/$version (+$APP_CONTACT)"
  fi
  printable='^[ -~]+$'
  url='^https?://[^[:space:]]+$'
  [[ "$USER_AGENT" =~ $printable && "$USER_AGENT" != *[\"\\]* ]] ||
    die "USER_AGENT must be printable ASCII without double quotes or backslashes"
  [[ "$RT_URL" =~ $url && "$RT_URL" != *[\"\\]* ]] || die "RT_URL must be an http or https URL without quotes"
  awk -v rt="$RT_URL" '{print} $1 == "path:" {print "      rt:"; print "        - url: \"" rt "\""}' "$run_config" >"$run_dir/data/config.yml"
  echo "user_agent: \"$USER_AGENT\"" >>"$run_dir/data/config.yml"
  rt_origin="$(printf '%s' "$RT_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  echo "realtime feed from $rt_origin with the User-Agent from the environment"
else
  cp "$run_dir/data/config.import.yml" "$run_dir/data/config.yml"
fi

cd "$run_dir"
started="$(date +%s)"
nohup "$MOTIS_BIN" server -d data >"$run_dir/server.log" 2>&1 &
server_pid=$!
echo "$server_pid" >"$pid_file"

fail() {
  kill -TERM "$server_pid" 2>/dev/null || true
  rm -f "$pid_file"
  cp "$run_dir/data/config.import.yml" "$run_dir/data/config.yml"
  die "$1"
}
trap 'fail "interrupted while waiting for health"' INT TERM HUP

deadline=$((started + ${HEALTH_TIMEOUT_S:-600}))
until curl --silent --fail --output /dev/null "http://127.0.0.1:$port/api/v1/health"; do
  kill -0 "$server_pid" 2>/dev/null || { tail -n 20 "$run_dir/server.log"; fail "server exited"; }
  (($(date +%s) < deadline)) || fail "server not healthy after ${HEALTH_TIMEOUT_S:-600} s"
  sleep 1
done
trap - INT TERM HUP
echo "server pid $server_pid healthy on 127.0.0.1:$port after $(($(date +%s) - started)) s, rss_mb $(($(ps -o rss= -p "$server_pid") / 1024))"
