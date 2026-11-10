#!/usr/bin/env bash
# Shared paths and helpers for the rail_graph scripts. Sourced, not executed.

RAIL_GRAPH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$RAIL_GRAPH_DIR/../.." && pwd)"
main_checkout() {
  git -C "$REPO_ROOT" worktree list --porcelain | awk 'NR==1 {print $2}'
}
MAIN="${GERLINES_MAIN:-$(main_checkout)}"
OUT="${RAIL_GRAPH_OUT:-$MAIN/data/rail_graph}"
TRAINS_ZIP="${TRAINS_ZIP:-$MAIN/data/static/2026-10-19/delfi-gtfs-trains.zip}"
OSM_PBF="${OSM_PBF:-$MAIN/data/inputs/osm/germany-2026-10-20.osm.pbf}"
RAIL_PBF="${RAIL_PBF:-$MAIN/data/router/osm/germany-2026-10-20-rail.osm.pbf}"
PFAEDLE_IMAGE="ghcr.io/ad-freiburg/pfaedle@sha256:af4fdc647699ea1ffe5150fd1f9d264c465c2876710ea749e8cb284f13abd20d"
PROC_ROOT="${PROC_ROOT:-/proc}"

die() {
  echo "error: $*" >&2
  exit 1
}

require_input() {
  [[ -f "${!1}" ]] || die "no file at ${!1}: set $1 to its path"
}

on_linux() {
  [[ "$(uname -s)" == Linux ]]
}

swap_used_mb() {
  if on_linux; then
    awk '$1 == "SwapTotal:" {t = $2} $1 == "SwapFree:" {f = $2} END {print int((t - f) / 1024)}' "$PROC_ROOT/meminfo"
    return
  fi
  sysctl -n vm.swapusage | awk '{for (i = 1; i <= NF; i++) if ($i == "used") {v = $(i + 2); sub("M", "", v); print int(v)}}'
}

free_percent() {
  if on_linux; then
    awk '$1 == "MemTotal:" {t = $2} $1 == "MemAvailable:" {a = $2} END {if (t > 0) print int(a * 100 / t)}' "$PROC_ROOT/meminfo"
    return
  fi
  memory_pressure | awk -F': ' '/System-wide memory free percentage/ {sub("%", "", $2); print $2}'
}

pressure_level() {
  if on_linux; then
    local psi
    psi="$(cat "$PROC_ROOT/pressure/memory" 2>/dev/null)" || psi=""
    awk '{for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) v[$1] = substr($i, 7) + 0}
      END {print (v["full"] >= 10) ? 4 : (v["some"] >= 10) ? 2 : 1}' <<<"$psi"
    return
  fi
  sysctl -n kern.memorystatus_vm_pressure_level
}

# Waits until free memory reaches the floor <percent>: refuses at once unless GUARD_WAIT_S gives a wait in seconds;
# then polls every GUARD_WAIT_INTERVAL_S (60) seconds, logs each wait to stderr and refuses when the wait ran out.
wait_for_free_memory() {
  local floor="$1" what="$2" limit="${GUARD_WAIT_S:-0}" interval="${GUARD_WAIT_INTERVAL_S:-60}" waited=0 free pause
  [[ "$limit" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "GUARD_WAIT_S must be a non-negative number of seconds, got '$limit'"
  [[ "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v i="$interval" 'BEGIN {exit !(i > 0)}' ||
    die "GUARD_WAIT_INTERVAL_S must be a positive number of seconds, got '$interval'"
  while :; do
    free="$(free_percent)"
    [[ -z "$free" ]] || ((free >= floor)) && return 0
    if awk -v w="$waited" -v l="$limit" 'BEGIN {exit !(w >= l)}'; then
      [[ "$waited" == 0 ]] && die "refusing to start: ${free} % memory free, floor ${floor} %"
      die "refusing to start: ${free} % memory free, floor ${floor} % after waiting ${waited} s"
    fi
    echo "$(date +%H:%M:%S) waiting for memory: ${free} % free, floor ${floor} %, waited ${waited} of ${limit} s ($what)" >&2
    pause="$(awk -v i="$interval" -v l="$limit" -v w="$waited" 'BEGIN {p = l - w; if (i < p) p = i; printf "%g", p}')"
    sleep "$pause"
    waited="$(awk -v w="$waited" -v p="$pause" 'BEGIN {printf "%g", w + p}')"
  done
}
