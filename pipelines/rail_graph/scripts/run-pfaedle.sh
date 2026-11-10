#!/usr/bin/env bash
# Runs pfaedle (-D -m rail) over the train-only DELFI subset in Docker with a memory guard.
# Usage: run-pfaedle.sh <run-name> [osm-file]     e.g. run-pfaedle.sh full   (default OSM: the whole Germany PBF)
# PFAEDLE_PARAMS_FILE: a file of pfaedle parameters in its cfg format, passed with -P on top of the image's
# config (comment lines dropped), e.g. config/pfaedle-strict-turns.cfg for the alternate run of P-T102-01.
# Output: $OUT/pfaedle/<run>/gtfs-out (shaped feed), stats.json, and $OUT/logs/pfaedle-<run>.{log,mem.csv,summary}.
# The guard samples host swap, the kernel pressure level and the container memory every GUARD_INTERVAL_S (5) and stops
# the container when swap grows by more than GUARD_SWAP_MB (2048) or pressure turns critical (level 4).
# Below GUARD_MIN_FREE_PERCENT (40) it refuses to start, or with GUARD_WAIT_S waits for memory (lib.sh
# wait_for_free_memory). GUARD_RETRIES (0) reruns pfaedle that many times after a guard stop that ended it with a
# failure, each once memory is back at the floor and swap within half of GUARD_SWAP_MB of the first start (the swap
# baseline of every attempt, so the retries share one allowance); earlier attempts keep their log and samples as
# pfaedle-<run>.attempt-<n>.{log,mem.csv}. A container that had already exited 0 when the guard fired is kept.
# Killed (INT, TERM, HUP), it stops the container, saves its log and removes it.
# Needs the Docker socket. Memory figures come from sysctl and memory_pressure on macOS and from /proc on Linux
# (meminfo, pressure/memory: level 4 when full avg10 reaches 10 %, 2 when some avg10 does, else 1).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run="${1:-}"
[[ -n "$run" ]] || die "usage: run-pfaedle.sh <run-name> [osm-file]"
osm="${2:-$OSM_PBF}"
[[ -f "$osm" ]] || die "no OSM file at $osm: pass it as the second argument or set OSM_PBF"
require_input TRAINS_ZIP
run_dir="$OUT/pfaedle/$run"
logs="$OUT/logs"
prefix="$logs/pfaedle-$run"
container="gerlines-sp3-pfaedle-$run"
guard_swap_mb="${GUARD_SWAP_MB:-2048}"
interval="${GUARD_INTERVAL_S:-5}"
mkdir -p "$run_dir" "$logs"
rm -rf "$run_dir/gtfs-out"

params_file="${PFAEDLE_PARAMS_FILE:-}"
params=()
if [[ -n "$params_file" ]]; then
  [[ -f "$params_file" ]] || die "no pfaedle parameter file at $params_file"
  params=(-P "$(grep -v '^[[:space:]]*#' "$params_file")")
  grep -v '^[[:space:]]*#' "$params_file" >"$run_dir/params.cfg"
else
  rm -f "$run_dir/params.cfg"
fi

min_free="${GUARD_MIN_FREE_PERCENT:-40}"
retries="${GUARD_RETRIES:-0}"
[[ "$retries" =~ ^[0-9]+$ ]] || die "GUARD_RETRIES must be a whole number, got '$retries'"
wait_for_free_memory "$min_free" "pfaedle $run"

stop_container() {
  docker stop -t 10 "$container" >/dev/null 2>&1 || true
}
abort() {
  trap - INT TERM HUP
  local pids
  pids="$(jobs -p)"
  [[ -z "$pids" ]] || kill $pids 2>/dev/null || true
  if docker inspect "$container" >/dev/null 2>&1; then
    stop_container
    docker logs "$container" >"$prefix.log" 2>&1 || true
    docker rm "$container" >/dev/null 2>&1 || true
  fi
  echo "interrupted, container stopped and removed" >>"$prefix.summary"
  exit "$1"
}
trap 'abort 130' INT
trap 'abort 143' TERM
trap 'abort 129' HUP

# Waits up to GUARD_WAIT_S until swap is back within half of the allowance above the first start.
swap_room() {
  local limit="${GUARD_WAIT_S:-0}" interval="${GUARD_WAIT_INTERVAL_S:-60}" waited=0 now
  while :; do
    now="$(swap_used_mb)"
    ((now - swap_base <= guard_swap_mb / 2)) && return 0
    if awk -v w="$waited" -v l="$limit" 'BEGIN {exit !(w >= l)}'; then
      echo "no retry: swap $now MB is $((now - swap_base)) MB above the first start, more than $((guard_swap_mb / 2)) MB" |
        tee -a "$prefix.summary" >&2
      return 1
    fi
    sleep "$interval" &
    wait $!
    waited="$(awk -v w="$waited" -v p="$interval" 'BEGIN {printf "%g", w + p}')"
  done
}

to_mb() {
  awk '{v = $1; u = v; gsub(/[0-9.]/, "", u); sub(/[A-Za-z]+$/, "", v);
    f = (u == "GiB") ? 1024 : (u == "MiB") ? 1 : (u == "KiB") ? 1 / 1024 : (u == "B") ? 1 / 1048576 : 1;
    printf "%d", v * f}'
}

attempt=1
: >"$prefix.summary"
swap_base="$(swap_used_mb)"
while :; do
  swap_start="$(swap_used_mb)"
  {
    echo "image $PFAEDLE_IMAGE"
    echo "osm $osm"
    echo "gtfs $TRAINS_ZIP"
    echo "params ${params_file:-none}"
    echo "attempt $attempt of $((retries + 1))"
    echo "swap_baseline_mb $swap_base"
    echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ) swap_used_mb $swap_start free_percent $(free_percent) pressure_level $(pressure_level)"
  } >>"$prefix.summary"

  started="$(date +%s)"
  docker run -d --name "$container" --platform linux/amd64 \
    --volume "$(dirname "$osm"):/osm:ro" \
    --volume "$(dirname "$TRAINS_ZIP"):/gtfs:ro" \
    --volume "$run_dir:/out" \
    --workdir /out \
    "$PFAEDLE_IMAGE" \
    -D -m rail --stats -d /out -o /out/gtfs-out \
    -x "/osm/$(basename "$osm")" -i "/gtfs/$(basename "$TRAINS_ZIP")" ${params[@]+"${params[@]}"} >/dev/null

  echo "epoch_s,container_mem_mb,swap_used_mb,free_percent,pressure_level" >"$prefix.mem.csv"
  stop_reason=""
  while [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]]; do
    mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$container" 2>/dev/null | awk -F' / ' '{print $1}' | to_mb)"
    swap_now="$(swap_used_mb)"
    level="$(pressure_level)"
    echo "$(date +%s),${mem:-0},$swap_now,$(free_percent),$level" >>"$prefix.mem.csv"
    if ((swap_now - swap_base > guard_swap_mb)); then
      stop_reason="swap grew from ${swap_base} MB to ${swap_now} MB"
    elif [[ "$level" == "4" ]]; then
      stop_reason="memory pressure critical"
    fi
    if [[ -n "$stop_reason" ]]; then
      stop_container
      break
    fi
    sleep "$interval" &
    wait $!
  done
  ended="$(date +%s)"

  status="$(docker inspect -f '{{.State.ExitCode}}' "$container")"
  docker logs "$container" >"$prefix.log" 2>&1
  docker rm "$container" >/dev/null
  {
    echo "end $(date -u +%Y-%m-%dT%H:%M:%SZ) swap_used_mb $(swap_used_mb) free_percent $(free_percent) pressure_level $(pressure_level)"
    echo "exit_status $status"
    echo "wall_seconds $((ended - started))"
    echo "peak_container_mem_mb $(awk -F, 'NR > 1 && $2 > m {m = $2} END {print m + 0}' "$prefix.mem.csv")"
    echo "max_swap_used_mb $(awk -F, 'NR > 1 && $3 > m {m = $3} END {print m + 0}' "$prefix.mem.csv")"
    echo "pressure_level_counts $(awk -F, 'NR > 1 {c[$5]++} END {for (k in c) printf "level%s=%d ", k, c[k]}' "$prefix.mem.csv")"
    echo "guard_stop ${stop_reason:-none}"
    [[ -n "$stop_reason" && "$status" == "0" ]] && echo "kept: the container had already exited 0"
  } >>"$prefix.summary"
  [[ -n "$stop_reason" && "$status" != "0" ]] && ((attempt <= retries)) || break
  swap_room || break
  mv "$prefix.log" "$prefix.attempt-$attempt.log"
  mv "$prefix.mem.csv" "$prefix.attempt-$attempt.mem.csv"
  echo "retry $attempt of $retries after guard stop: $stop_reason" | tee -a "$prefix.summary" >&2
  wait_for_free_memory "$min_free" "pfaedle $run retry $attempt"
  rm -rf "$run_dir/gtfs-out"
  attempt=$((attempt + 1))
done
cat "$prefix.summary"
[[ "$status" == "0" ]]
