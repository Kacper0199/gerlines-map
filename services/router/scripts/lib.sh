#!/usr/bin/env bash
# Shared paths and helpers for the router scripts. Sourced, not executed.

ROUTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROUTER_DIR/../.." && pwd)"
main_checkout() {
  git -C "$REPO_ROOT" worktree list --porcelain | awk 'NR==1 {print $2}'
}
[[ -n "${ROUTER_DATA:-}" ]] || ROUTER_DATA="$(main_checkout)/data/router"
INPUTS="${GERLINES_INPUTS:-}"
[[ -n "$INPUTS" ]] || INPUTS="$(main_checkout)/data/inputs"
DELFI_ZIP="${DELFI_ZIP:-$INPUTS/delfi/2026-10-19/delfi-gtfs.zip}"
OSM_PBF="${OSM_PBF:-$INPUTS/osm/germany-2026-10-20.osm.pbf}"
RAIL_PBF="${RAIL_PBF:-$ROUTER_DATA/osm/germany-2026-10-20-rail.osm.pbf}"
MOTIS_BIN="${MOTIS_BIN:-$ROUTER_DATA/bin/motis}"
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

run_port() {
  awk -F'"' '$1 ~ /^  port: / {print $2; exit}' "$ROUTER_DATA/runs/$1/config.yml"
}

run_dataset() {
  awk '/^  datasets:/ {getline; sub(/^ +/, ""); sub(/:$/, ""); print; exit}' "$ROUTER_DATA/runs/$1/config.yml"
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

pageouts() {
  if on_linux; then
    awk '$1 == "pswpout" {print $2}' "$PROC_ROOT/vmstat"
    return
  fi
  vm_stat | awk '/Pageouts/ {gsub("\\.", "", $2); print $2}'
}

memory_snapshot() {
  echo "time $(date -u +%Y-%m-%dT%H:%M:%SZ) free_percent $(free_percent) swap_used_mb $(swap_used_mb) pageouts $(pageouts)"
}
