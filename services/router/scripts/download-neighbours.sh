#!/usr/bin/env bash
# Downloads the neighbouring regions' Geofabrik extracts one at a time and checks each against Geofabrik's md5.
# Usage: download-neighbours.sh <out-dir> [regions-file]   (default regions: config/neighbours.txt)
# Env: USER_AGENT, or APP_NAME and APP_CONTACT (see README); MAX_BYTES (default 7000000000) caps the whole set:
# every size is read with HEAD first, and the script stops before downloading anything when the set would exceed it.
# Writes <out-dir>/<id>.osm.pbf with a sidecar <id>.osm.pbf.json (url, fetched_at, bytes, last_modified, md5, sha256).
# A file whose sidecar exists and whose size and sha256 still match is skipped, so a rerun continues.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out="${1:-}"
regions="${2:-$ROUTER_DIR/config/neighbours.txt}"
[[ -n "$out" ]] || die "usage: download-neighbours.sh <out-dir> [regions-file]"
[[ -f "$regions" ]] || die "missing $regions"
if [[ -z "${USER_AGENT:-}" ]]; then
  [[ -n "${APP_NAME:-}" && -n "${APP_CONTACT:-}" ]] || die "needs USER_AGENT, or APP_NAME and APP_CONTACT, in the environment"
  version="$(awk -F'"' '/"version"/ {print $4; exit}' "$REPO_ROOT/package.json")"
  USER_AGENT="$APP_NAME/$version (+$APP_CONTACT)"
fi
max_bytes="${MAX_BYTES:-7000000000}"
mkdir -p "$out"

size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fetch() { curl --fail --silent --show-error --location --retry 3 --max-time 3600 -H "User-Agent: $USER_AGENT" "$@"; }

complete() {
  local file="$1" meta="$1.json"
  [[ -f "$file" && -f "$meta" ]] || return 1
  [[ "$(size_of "$file")" == "$(jq -r .bytes "$meta")" && "$(sha_of "$file")" == "$(jq -r .sha256 "$meta")" ]]
}

regions_list=()
while read -r id url; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  regions_list+=("$id $url")
done <"$regions"

planned=0
sizes=()
for entry in "${regions_list[@]}"; do
  read -r id url <<<"$entry"
  head="$(fetch --head "$url")"
  bytes="$(awk 'tolower($1) == "content-length:" {v = $2} END {gsub("\r", "", v); print v}' <<<"$head")"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "no size for $url"
  sizes+=("$bytes")
  planned=$((planned + bytes))
  sleep 1
done
((planned <= max_bytes)) || die "the set is $planned bytes, above MAX_BYTES $max_bytes: nothing downloaded"
echo "planned $planned bytes in ${#regions_list[@]} files"

total=0
for n in "${!regions_list[@]}"; do
  read -r id url <<<"${regions_list[$n]}"
  file="$out/$id.osm.pbf"
  if complete "$file"; then
    total=$((total + $(size_of "$file")))
    echo "kept $id $(size_of "$file") bytes"
    continue
  fi
  head="$(fetch --head "$url")"
  bytes="$(awk 'tolower($1) == "content-length:" {v = $2} END {gsub("\r", "", v); print v}' <<<"$head")"
  modified="$(awk 'tolower($1) == "last-modified:" {$1 = ""; v = $0} END {gsub("\r", "", v); sub(/^ /, "", v); print v}' <<<"$head")"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "no size for $url"
  [[ "$bytes" == "${sizes[$n]}" ]] || echo "note: $id changed size since the check, ${sizes[$n]} to $bytes bytes"
  fetched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fetch --output "$file.part" "$url"
  got="$(md5 -q "$file.part" 2>/dev/null || md5sum "$file.part" | cut -d' ' -f1)"
  md5="$(fetch "$url.md5" | awk '{print $1}')"
  if [[ "$got" != "$md5" ]]; then
    sleep 5
    md5="$(fetch "$url.md5" | awk '{print $1}')"
    [[ "$got" == "$md5" ]] || die "$id: md5 differs from $url.md5 (Geofabrik may have updated it meanwhile: rerun)"
  fi
  bytes="$(size_of "$file.part")"
  mv "$file.part" "$file"
  jq -n --arg url "$url" --arg fetched_at "$fetched_at" --argjson bytes "$bytes" --arg last_modified "$modified" \
    --arg md5 "$md5" --arg sha256 "$(sha_of "$file")" --arg file "$id.osm.pbf" \
    '{url: $url, fetched_at: $fetched_at, bytes: $bytes, last_modified: $last_modified, md5: $md5, sha256: $sha256,
      file: $file, licence: "ODbL-1.0", attribution: "OpenStreetMap contributors, extract by Geofabrik GmbH"}' >"$file.json"
  total=$((total + bytes))
  echo "fetched $id $bytes bytes, set $total bytes"
  sleep 2
done
echo "done $total bytes in $out"
