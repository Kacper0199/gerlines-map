#!/usr/bin/env bash
# Runs one heavy command under /usr/bin/time (-l on macOS, -v on Linux) with a memory guard and writes
# <log-prefix>.{log,time,mem.csv,summary}.
# The guard stops the command when swap use grows by more than GUARD_SWAP_MB (default 2048) over the start value or the
# kernel memory pressure level turns critical (kern.memorystatus_vm_pressure_level = 4). It refuses to start at all
# above GUARD_MAX_SWAP_MB swap used (default 4096) or below GUARD_MIN_FREE_PERCENT free memory (default 40).
# Interrupting the script (INT, TERM, HUP) stops the measured command too.
# Usage: run-measured.sh <log-prefix> <command> [args...]
# macOS reads memory with sysctl, memory_pressure and vm_stat. Linux reads /proc (meminfo, vmstat, pressure/memory:
# level 4 when full avg10 reaches 10 %, 2 when some avg10 does, else 1) and needs GNU time for the peak RSS; without
# /usr/bin/time it falls back to the bash time keyword and records no peak memory. Both need ps and pgrep.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -ge 2 ]] || die "usage: run-measured.sh <log-prefix> <command> [args...]"
prefix="$1"
shift
mkdir -p "$(dirname "$prefix")"
guard_swap_mb="${GUARD_SWAP_MB:-2048}"
interval="${GUARD_INTERVAL_S:-5}"
max_swap_mb="${GUARD_MAX_SWAP_MB:-4096}"
min_free_percent="${GUARD_MIN_FREE_PERCENT:-40}"

descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    echo "$child"
    descendants "$child"
  done
}

tree_rss_kb() {
  local pids
  pids="$(descendants "$1" | tr '\n' ',')"
  [[ -n "$pids" ]] || { echo 0; return; }
  ps -o rss= -p "${pids%,}" 2>/dev/null | awk '{s += $1} END {print s + 0}'
}

stop_tree() {
  local pids
  pids="$(descendants "$1")"
  [[ -z "$pids" ]] || kill "-$2" $pids 2>/dev/null || true
}

swap_start="$(swap_used_mb)"
free_start="$(free_percent)"
if ((swap_start > max_swap_mb)) || ((free_start < min_free_percent)); then
  die "refusing to start: swap used ${swap_start} MB (ceiling ${max_swap_mb}), free ${free_start} % (floor ${min_free_percent}); raise GUARD_MAX_SWAP_MB or lower GUARD_MIN_FREE_PERCENT to override"
fi
{
  echo "command $*"
  echo "start $(memory_snapshot) pressure_level $(pressure_level)"
} >"$prefix.summary"

started="$(date +%s)"
if ! on_linux; then
  /usr/bin/time -l "$@" >"$prefix.log" 2>"$prefix.time" &
elif [[ -x /usr/bin/time ]]; then
  /usr/bin/time -v "$@" >"$prefix.log" 2>"$prefix.time" &
else
  echo "timer bash time, /usr/bin/time not found: no peak memory figure" | tee -a "$prefix.summary" >&2
  { time "$@"; } >"$prefix.log" 2>"$prefix.time" &
fi
time_pid=$!
on_signal() {
  stop_tree "$time_pid" TERM
  sleep 5
  stop_tree "$time_pid" KILL
  kill "$time_pid" 2>/dev/null || true
  echo "interrupted, measured command stopped" >>"$prefix.summary"
  exit 143
}
trap on_signal INT TERM HUP

echo "epoch_s,rss_mb,swap_used_mb,free_percent,pressure_level" >"$prefix.mem.csv"
stop_reason=""
while kill -0 "$time_pid" 2>/dev/null; do
  swap_now="$(swap_used_mb)"
  level="$(pressure_level)"
  rss_kb="$(tree_rss_kb "$time_pid")"
  echo "$(date +%s),$((rss_kb / 1024)),$swap_now,$(free_percent),$level" >>"$prefix.mem.csv"
  if ((swap_now - swap_start > guard_swap_mb)); then
    stop_reason="swap grew from ${swap_start} MB to ${swap_now} MB"
  elif [[ "$level" == "4" ]]; then
    stop_reason="memory pressure critical"
  fi
  if [[ -n "$stop_reason" ]]; then
    stop_tree "$time_pid" TERM
    sleep 10
    stop_tree "$time_pid" KILL
    break
  fi
  sleep "$interval"
done

set +e
wait "$time_pid"
status=$?
set -e
ended="$(date +%s)"

peak_rss_bytes="$(awk '/maximum resident set size/ {print $1} /Maximum resident set size \(kbytes\)/ {printf "%.0f\n", $NF * 1024}' "$prefix.time")"
peak_footprint_bytes="$(awk '/peak memory footprint/ {print $1}' "$prefix.time")"
{
  echo "end $(memory_snapshot) pressure_level $(pressure_level)"
  echo "exit_status $status"
  echo "wall_seconds $((ended - started))"
  echo "peak_rss_bytes ${peak_rss_bytes:-unknown}"
  echo "peak_rss_gib $(awk -v b="${peak_rss_bytes:-0}" 'BEGIN {printf "%.2f", b / 1073741824}')"
  echo "peak_footprint_bytes ${peak_footprint_bytes:-unknown}"
  echo "max_swap_used_mb $(awk -F, 'NR > 1 && $3 > m {m = $3} END {print m + 0}' "$prefix.mem.csv")"
  echo "min_free_percent $(awk -F, 'NR == 2 {m = $4} NR > 1 && $4 < m {m = $4} END {print m + 0}' "$prefix.mem.csv")"
  echo "pressure_level_counts $(awk -F, 'NR > 1 {c[$5]++} END {for (k in c) printf "level%s=%d ", k, c[k]}' "$prefix.mem.csv")"
  echo "guard_stop ${stop_reason:-none}"
} >>"$prefix.summary"
cat "$prefix.summary"
exit "$status"
