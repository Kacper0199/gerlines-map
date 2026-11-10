#!/usr/bin/env bash
# Pulls the official DELFI GTFS-RT feed from Mobilithek every 60 s for a fixed number of minutes.
# Usage: pull-mobilithek.sh <out-dir> <minutes>
# Secrets are loaded from the main checkout .env into this process only and reach curl through a config on stdin.
set -u

root="${GERLINES_MAIN:-$(git rev-parse --show-toplevel)}"
out="${1:?out dir}"
minutes="${2:?minutes}"
mkdir -p "$out/payloads"
log="$out/pull-log.csv"
[[ -f "$log" ]] || echo "requested_utc,http_code,bytes,last_modified,time_total_s,file" > "$log"

set -a
# shellcheck disable=SC1091
source "$root/.env"
set +a

p12="$root/${MOBILITHEK_CERT_P12:-secrets/mobilithek/gerlines-recorder.p12}"
pw="${MOBILITHEK_CERT_PASSWORD//\\/\\\\}"
pw="${pw//\"/\\\"}"
url="https://mobilithek.info:8443/mobilithek/api/v1.0/container/subscription?subscriptionID=${MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID}"
ua="${APP_NAME:-gerlines}/0.0 (+${APP_CONTACT:-unset})"
unset MOBILITHEK_CERT_PASSWORD DB_API_KEY DB_CLIENT_ID

last_modified=""
end=$(( $(date +%s) + minutes * 60 ))
while (( $(date +%s) < end )); do
  tick=$(date +%s)
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  body="$out/payloads/$stamp.pb.gz"
  hdr="$out/payloads/$stamp.hdr"
  ims=()
  [[ -n "$last_modified" ]] && ims=(-H "If-Modified-Since: $last_modified")
  meta="$(printf 'cert = "%s"\ncert-type = "P12"\npass = "%s"\n' "$p12" "$pw" | curl -sS -K - --max-time 50 \
    -H "Accept-Encoding: gzip" -H "User-Agent: $ua" ${ims[@]+"${ims[@]}"} -D "$hdr" -o "$body" \
    -w '%{http_code},%{size_download},%{time_total}' "$url" 2>>"$out/curl-errors.log")"
  code="${meta%%,*}"
  rest="${meta#*,}"
  bytes="${rest%%,*}"
  ttotal="${rest#*,}"
  lm="$(grep -i '^last-modified:' "$hdr" 2>/dev/null | head -1 | cut -d' ' -f2- | tr -d '\r')"
  if [[ "$code" == "200" && "${bytes:-0}" -gt 0 ]]; then
    [[ -n "$lm" ]] && last_modified="$lm"
    file="$(basename "$body")"
  else
    rm -f "$body"
    file=""
  fi
  echo "$stamp,$code,$bytes,\"$lm\",$ttotal,$file" >> "$log"
  sleep_for=$(( 60 - ($(date +%s) - tick) ))
  (( sleep_for > 0 )) && sleep "$sleep_for"
done
echo "done $(date -u +%FT%TZ)" >> "$out/pull-done.txt"
