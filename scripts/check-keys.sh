#!/usr/bin/env bash
# Checks the keys in .env against the real services without printing secret values. See docs/KEYS.md.
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.env"
if [[ ! -f "$env_file" ]]; then
  echo "FAIL  .env not found. Run: cp .env.example .env"
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf 'SKIP  %s\n' "$1"; }

ua="${APP_NAME:-gerlines}/0.0 (+${APP_CONTACT:-unset})"

if [[ -n "${APP_NAME:-}" && -n "${APP_CONTACT:-}" ]]; then
  pass "APP_NAME and APP_CONTACT set"
else
  fail "APP_NAME and APP_CONTACT must both be set"
fi

# Secrets reach curl as a config file on stdin (curl -K -) from the printf builtin, never as arguments that ps shows.
curl_quote() {
  local value="${1//\\/\\\\}"
  printf '%s' "${value//\"/\\\"}"
}

db_get() {
  printf 'header = "DB-Client-Id: %s"\nheader = "DB-Api-Key: %s"\n' \
    "$(curl_quote "${DB_CLIENT_ID}")" "$(curl_quote "${DB_API_KEY}")" \
    | curl -sS -K - -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "Accept: $2" -H "User-Agent: $ua" "$1"
}

if [[ -n "${DB_CLIENT_ID:-}" && -n "${DB_API_KEY:-}" ]]; then
  base="https://apis.deutschebahn.com/db-api-marketplace/apis"
  code="$(db_get "$base/timetables/v1/station/Frankfurt" "application/xml")"
  case "$code" in
    200) pass "K1 DB Timetables (HTTP 200)" ;;
    401|403) fail "K1 DB Timetables rejected the key (HTTP $code): check the Free subscription" ;;
    *) fail "K1 DB Timetables unexpected HTTP $code" ;;
  esac
  code="$(db_get "$base/station-data/v2/stations?searchstring=Frankfurt*&limit=1" "application/json")"
  case "$code" in
    200) pass "K1 DB StaDa (HTTP 200)" ;;
    401|403) warn "K1 DB StaDa rejected the key (HTTP $code): check the Free4All subscription" ;;
    *) warn "K1 DB StaDa HTTP $code: endpoint path to be confirmed in WP-2.4" ;;
  esac
  code="$(db_get "$base/fasta/v2/facilities?type=ELEVATOR&state=ACTIVE" "application/json")"
  case "$code" in
    200) pass "K1 DB FaSta (HTTP 200)" ;;
    401|403) warn "K1 DB FaSta rejected the key (HTTP $code): check the Free4All subscription" ;;
    *) warn "K1 DB FaSta HTTP $code: endpoint path to be confirmed in WP-2.4" ;;
  esac
else
  fail "K1 DB_CLIENT_ID and DB_API_KEY not set"
fi

if [[ -n "${OTD_CH_API_KEY:-}" ]]; then
  url="https://api.opentransportdata.swiss/la/gtfs-rt"
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$(curl_quote "${OTD_CH_API_KEY}")" \
    | curl -sS -L -K - -o /dev/null -w '%{http_code}' --max-time 30 -H "User-Agent: $ua" "$url")"
  case "$code" in
    200) pass "K2 opentransportdata.swiss (HTTP 200)" ;;
    429) warn "K2 opentransportdata.swiss rate limited (five requests per minute); run again in a minute" ;;
    *) warn "K2 opentransportdata.swiss HTTP $code" ;;
  esac
else
  skip "K2 OTD_CH_API_KEY not set (optional)"
fi

if [[ -n "${MOBILITHEK_CERT_PASSWORD:-}" && -n "${MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID:-}" ]]; then
  p12="$root/${MOBILITHEK_CERT_P12:-secrets/mobilithek/gerlines-recorder.p12}"
  if [[ -f "$p12" ]]; then
    pw="$(curl_quote "${MOBILITHEK_CERT_PASSWORD}")"
    url="https://mobilithek.info:8443/mobilithek/api/v1.0/container/subscription?subscriptionID=${MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID}"
    since="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')"
    code="$(printf 'cert = "%s"\ncert-type = "P12"\npass = "%s"\n' "$p12" "$pw" | curl -sS -K - -o /dev/null -w '%{http_code}' --max-time 30 \
      -H "Accept-Encoding: gzip" -H "If-Modified-Since: $since" -H "User-Agent: $ua" "$url")"
    case "$code" in
      200|204|304) pass "K3 Mobilithek DELFI GTFS-RT subscription (HTTP $code)" ;;
      000) warn "K3 Mobilithek connection failed: check the certificate file and MOBILITHEK_CERT_PASSWORD" ;;
      400) warn "K3 Mobilithek did not receive a client certificate (HTTP 400)" ;;
      403) warn "K3 Mobilithek refused the certificate for this subscription (HTTP 403)" ;;
      404) warn "K3 Mobilithek subscription not found or no longer valid (HTTP 404)" ;;
      *) warn "K3 Mobilithek HTTP $code" ;;
    esac
  else
    warn "K3 Mobilithek certificate not found at ${p12#"$root"/}"
  fi
else
  skip "K3 MOBILITHEK_CERT_PASSWORD or MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID not set (optional)"
fi

if [[ -n "${SNCB_API_KEY:-}" ]]; then
  warn "SNCB_API_KEY set, not testable by status code (the gateway answers 200 without a key); check the portal's Reports page (docs/KEYS.md)"
else
  skip "SNCB_API_KEY not set (optional)"
fi

echo
if (( failures > 0 )); then
  echo "$failures required check(s) failed."
  exit 1
fi
echo "All required keys work."
