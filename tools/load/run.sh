#!/usr/bin/env bash
# Local load test of the live push path and the API (WP-9.4). Usage and limits: tools/load/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

K6_IMAGE="grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8"
K6_CONTAINER="gerlines-load-k6"
K6_MEMORY="${LOAD_K6_MEMORY:-1536m}"
NETWORK="gerlines_default"
VALKEY_CONTAINER="gerlines-valkey-1"
CENTRIFUGO_CONTAINER="gerlines-centrifugo-1"
LIVE_PORT="${LOAD_LIVE_PORT:-8814}"
API_PORT="${LOAD_API_PORT:-8815}"
LIVE_CLOCK="${LOAD_LIVE_CLOCK:-replay:2026-10-25T15:00:00Z:1}"
MIN_FREE_MEMORY_START="${LOAD_MIN_FREE_MEMORY_START:-40}"
MIN_FREE_MEMORY="${LOAD_MIN_FREE_MEMORY:-25}"
MIN_FREE_DISK_GIB="${LOAD_MIN_FREE_DISK_GIB:-41.0}"
MARKER="${LOAD_MARKER:-$repo_root/data/locks/heavy-load.txt}"
: "${LOAD_DIR:?set LOAD_DIR to an absolute directory for state and results}"
state="$LOAD_DIR/state"
results="$LOAD_DIR/results"
mkdir -p "$state" "$results"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOAD_DIR/run.log" >&2; }

free_memory() {
  if [[ "$(uname -s)" == Linux ]]; then
    awk '$1 == "MemTotal:" {t = $2} $1 == "MemAvailable:" {a = $2} END {print int(a * 100 / t)}' /proc/meminfo
  else
    memory_pressure | awk -F': ' '/free percentage/ {print $2 + 0}'
  fi
}
free_disk_gib() { df -Pk "$LOAD_DIR" | awk 'NR == 2 {printf "%.1f", $4 / 1048576}'; }

resources_ok() {
  local floor="$1" memory disk
  memory="$(free_memory)"
  disk="$(free_disk_gib)"
  if ((memory < floor)); then
    log "memory free ${memory} % is under ${floor} %"
    return 1
  fi
  if awk -v d="$disk" -v f="$MIN_FREE_DISK_GIB" 'BEGIN {exit !(d < f)}'; then
    log "disk free ${disk} GiB is under ${MIN_FREE_DISK_GIB} GiB"
    return 1
  fi
  log "resources: memory free ${memory} %, disk free ${disk} GiB"
}

valkey_db() {
  local url="${VALKEY_URL:?set VALKEY_URL ending in a database number of its own, such as /11}"
  local db="${url##*/}"
  [[ "$db" =~ ^[0-9]+$ ]] || { log "VALKEY_URL must end with a database number"; exit 2; }
  printf '%s' "$db"
}

container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

wait_for() {
  local what="$1" seconds="$2"
  shift 2
  local deadline=$((SECONDS + seconds))
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS > deadline)); then
      log "$what not ready after ${seconds} s"
      return 1
    fi
    sleep 2
  done
  log "$what ready"
}

healthy() { [[ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" == "healthy" ]]; }

start_stores() {
  : >"$state/containers"
  for container in "$VALKEY_CONTAINER" "$CENTRIFUGO_CONTAINER"; do
    container_running "$container" || echo "$container" >>"$state/containers"
  done
  bash "$repo_root/infra/compose.sh" --profile live up -d valkey centrifugo
  wait_for valkey 60 healthy "$VALKEY_CONTAINER"
  wait_for centrifugo 60 healthy "$CENTRIFUGO_CONTAINER"
  docker exec "$VALKEY_CONTAINER" valkey-cli -n "$(valkey_db)" flushdb >/dev/null
}

start_process() {
  local name="$1" directory="$2"
  shift 2
  (cd "$directory" && exec nohup "$@" >"$LOAD_DIR/$name.log" 2>&1) &
  echo $! >"$state/$name.pid"
  log "$name started, pid $!"
}

stop_process() {
  local name="$1" pid
  [[ -f "$state/$name.pid" ]] || return 0
  pid="$(cat "$state/$name.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -KILL "$pid" 2>/dev/null || true
    log "$name stopped, pid $pid"
  fi
  rm -f "$state/$name.pid"
}

prepare_live_dir() {
  local packs="${LOAD_LIVE_PACKS:?set LOAD_LIVE_PACKS to a packs directory holding s/<epoch>/complete.json}"
  local out="$LOAD_DIR/live"
  rm -rf "$out"
  mkdir -p "$out"
  ln -s "$packs/s" "$out/s"
  printf '%s' "$out"
}

head_ok() { curl -fsS -o /dev/null "http://127.0.0.1:$LIVE_PORT/live/v1/head"; }
api_ok() { curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/api/health"; }
search_ok() { curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/api/v1/search?q=Berlin"; }
keys_ok() { [[ "$(docker exec "$VALKEY_CONTAINER" valkey-cli -n "$(valkey_db)" --scan --pattern 'live:inst:*' --count 1000 | wc -l)" -gt 500 ]]; }

command_up() {
  start_stores
  local out
  out="$(prepare_live_dir)"
  start_process live "$repo_root/services/live" node src/cli.ts run --out "$out" --port "$LIVE_PORT" --clock "$LIVE_CLOCK"
  wait_for "live head" 240 head_ok
  wait_for "frame keys" 240 keys_ok
  start_process api "$repo_root" env API_PORT="$API_PORT" API_HOST=127.0.0.1 \
    LOAD_LIVE_ORIGIN="http://127.0.0.1:$LIVE_PORT" \
    API_TRUSTED_PROXIES="${LOAD_TRUSTED_PROXIES:-127.0.0.1/32,::1/128,192.168.65.0/24}" \
    node tools/load/api-replay.ts
  wait_for api 60 api_ok
  wait_for search "${LOAD_SEARCH_WAIT_S:-60}" search_ok || log "search index not built: search answers 503 in this run"
}

command_down() {
  docker rm -f "$K6_CONTAINER" >/dev/null 2>&1 || true
  stop_process sampler
  stop_process api
  stop_process live
  if container_running "$VALKEY_CONTAINER"; then
    docker exec "$VALKEY_CONTAINER" valkey-cli -n "$(valkey_db)" flushdb >/dev/null || true
  fi
  if [[ -f "$state/containers" ]]; then
    while read -r container; do
      [[ -n "$container" ]] || continue
      docker stop "$container" >/dev/null && log "$container stopped"
    done <"$state/containers"
    rm -f "$state/containers"
  fi
}

write_ids() {
  local db
  db="$(valkey_db)"
  docker exec "$VALKEY_CONTAINER" valkey-cli -n "$db" --scan --pattern 'live:train:*' --count 1000 >"$state/train-keys.txt"
  docker exec "$VALKEY_CONTAINER" valkey-cli -n "$db" --scan --pattern 'live:inst:*' --count 1000 >"$state/inst-keys.txt"
  head -n 500 "$state/inst-keys.txt" | docker exec -i "$VALKEY_CONTAINER" sh -c "xargs valkey-cli -n $db mget" >"$state/inst-trips.txt"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [trainFile, instFile, tripFile, out] = process.argv.slice(1);
    const read = (file, prefix) => readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
    const uuid = /^[0-9a-f-]{36}$/;
    const detailed = read(trainFile, "live:train:").filter((id) => uuid.test(id));
    const running = readFileSync(tripFile, "utf8").split("\n").map((line) => line.trim()).filter((id) => uuid.test(id));
    const trains = detailed.length > 0 ? detailed : running;
    const keys = read(instFile, "live:inst:").filter((key) => /^\d+$/.test(key));
    writeFileSync(out, JSON.stringify({ trains, keys, detailed: detailed.length }));
    console.log(`ids: ${detailed.length} train details, ${trains.length} train ids, ${keys.length} frame keys`);
  ' "$state/train-keys.txt" "$state/inst-keys.txt" "$state/inst-trips.txt" "$LOAD_DIR/ids.json" | tee -a "$LOAD_DIR/run.log"
}

sample_resources() {
  local file="$1"
  echo "time,name,cpu,memory" >"$file"
  while true; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
      "$CENTRIFUGO_CONTAINER" "$VALKEY_CONTAINER" "$K6_CONTAINER" 2>/dev/null |
      sed "s/^/$(date +%H:%M:%S),/" >>"$file" || true
    for name in live api; do
      if [[ -f "$state/$name.pid" ]]; then
        ps -o %cpu=,rss= -p "$(cat "$state/$name.pid")" 2>/dev/null |
          awk -v t="$(date +%H:%M:%S)" -v n="$name" '{printf "%s,%s,%s%%,%.0fMiB\n", t, n, $1, $2 / 1024}' >>"$file" || true
      fi
    done
    sleep 5
  done
}

guard() {
  while container_running "$K6_CONTAINER" || [[ ! -f "$state/k6.done" ]]; do
    if ! resources_ok "$MIN_FREE_MEMORY" >/dev/null 2>&1; then
      resources_ok "$MIN_FREE_MEMORY" || true
      echo "resources" >"$state/abort"
      docker kill "$K6_CONTAINER" >/dev/null 2>&1 || true
      return
    fi
    sleep 10
  done
}

run_k6() {
  local run="$1" script="$2"
  shift 2
  [[ ! -f "$state/abort" ]] || { log "aborted earlier, $run skipped"; return 1; }
  resources_ok "$MIN_FREE_MEMORY" || { echo "resources" >"$state/abort"; return 1; }
  rm -f "$state/k6.done"
  [[ -f "$LOAD_DIR/ids.json" ]] || echo '{"trains":[],"keys":[]}' >"$LOAD_DIR/ids.json"
  sample_resources "$results/$run.resources.csv" &
  echo $! >"$state/sampler.pid"
  guard &
  local guard_pid=$! status=0
  log "k6 $run started"
  docker run --rm --name "$K6_CONTAINER" --network "$NETWORK" --memory "$K6_MEMORY" \
    --ulimit nofile=65536:65536 --add-host=host.docker.internal:host-gateway \
    -v "$here/k6:/scripts:ro" -v "$results:/out" -v "$LOAD_DIR/ids.json:/ids/ids.json:ro" \
    -e LOAD_RUN="$run" -e LOAD_OUT=/out -e IDS_FILE=/ids/ids.json -e CENTRIFUGO_HTTP_API_KEY \
    "$@" "$K6_IMAGE" run --quiet "/scripts/$script" >"$results/$run.txt" 2>"$results/$run.log" || status=$?
  touch "$state/k6.done"
  wait "$guard_pid" 2>/dev/null || true
  stop_process sampler
  log "k6 $run finished with status $status"
  cat "$results/$run.txt" >&2
  return 0
}

command_push() {
  local clients="$1"
  run_k6 "push-$clients" push.js -e CLIENTS="$clients" -e RAMP_S="${LOAD_RAMP_S:-15}" \
    -e HOLD_S="${LOAD_HOLD_S:-60}" -e SOCKETS_PER_VU="${LOAD_SOCKETS_PER_VU:-100}"
}

command_api() {
  local name="${1:-base}" factor="${2:-1}"
  write_ids
  run_k6 "api-$name" api.js -e DURATION_S="${LOAD_API_SECONDS:-60}" \
    -e API_ORIGIN="http://host.docker.internal:$API_PORT" \
    -e RATE_TRAINS=$((20 * factor)) -e RATE_KEYS=$((20 * factor)) -e RATE_SEARCH=$((10 * factor)) \
    -e RATE_STATIONS=$((5 * factor)) -e RATE_STATUS=$((5 * factor))
}

command_traffic() {
  local mode="${LOAD_TRAFFIC_MODE:-poll}"
  run_k6 "traffic$([[ "$mode" == poll ]] || printf -- '-%s' "$mode")" traffic.js -e FOLLOWERS="${LOAD_FOLLOWERS:-20}" \
    -e DURATION_S="${LOAD_TRAFFIC_SECONDS:-300}" -e LIVE_ORIGIN="http://host.docker.internal:$LIVE_PORT" \
    -e MODE="$mode"
}

write_marker() {
  mkdir -p "$(dirname "$MARKER")"
  printf 'owner: %s\njob: tools/load/run.sh all (k6 push, API and traffic)\nstart: %s\nexpected end: %s\npid: %s\n' \
    "${LOAD_OWNER:-load test}" "$(date -u +%FT%TZ)" "$(date -u -d '+45 min' +%FT%TZ 2>/dev/null || date -u -v+45M +%FT%TZ)" "$$" >"$MARKER"
}

finish_all() {
  command_down
  rm -f "$MARKER"
  log "stack stopped, marker removed"
}

command_all() {
  resources_ok "$MIN_FREE_MEMORY_START" || { log "not started: needs ${MIN_FREE_MEMORY_START} % memory free"; exit 3; }
  rm -f "$state/abort"
  write_marker
  trap finish_all EXIT
  trap 'exit 130' INT TERM
  command_up
  write_ids
  local stages=" ${LOAD_STAGES:-push api traffic} "
  if [[ "$stages" == *" push "* ]]; then
    for clients in ${LOAD_CLIENTS:-500 1000 3000}; do
      command_push "$clients"
    done
  fi
  if [[ "$stages" == *" api "* ]]; then
    command_api base 1
    command_api x4 4
  fi
  [[ "$stages" != *" traffic "* ]] || command_traffic
  [[ ! -f "$state/abort" ]] || log "stopped early: resource floor reached"
}

case "${1:-}" in
  up) command_up ;;
  down) command_down ;;
  push) command_push "${2:?clients}" ;;
  api) command_api "${2:-base}" "${3:-1}" ;;
  traffic) command_traffic ;;
  all) command_all ;;
  *)
    echo "usage: tools/load/run.sh up | down | push CLIENTS | api [NAME FACTOR] | traffic | all" >&2
    exit 2
    ;;
esac
