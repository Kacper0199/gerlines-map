#!/usr/bin/env bash
# Checks the production stack (infra/compose.production.yaml over infra/compose.yaml) before a deployment, without
# deploying or starting anything that listens outside a container of its own. See docs/runbooks/deploy.md.
#   bash scripts/check-deploy.sh                    render with dummy values, every check
#   bash scripts/check-deploy.sh --offline          the same without the container checks (no Docker images needed)
#   bash scripts/check-deploy.sh --pull             pull a missing pinned image (Caddy, Centrifugo) instead of failing
#   bash scripts/check-deploy.sh --env-file <path>  render the real production env file instead; prints names, never values
#   bash scripts/check-deploy.sh --dist <path>      also check that every .br, .zst and .gz in the web build decodes to its file
# Needs docker (compose v2.24 or newer), node, openssl. Exit 1 when any check fails.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="$root/infra/compose.yaml"
overlay="$root/infra/compose.production.yaml"
production="$root/infra/production"
caddy_image="$(sed -n 's/^    image: \(caddy:[^ ]*\)$/\1/p' "$overlay")"
centrifugo_image="$(sed -n 's/^    image: \(centrifugo\/centrifugo:[^ ]*\)$/\1/p' "$base")"

offline=0
pull=0
env_file=""
dist=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) offline=1 ;;
    --pull) pull=1 ;;
    --env-file)
      env_file="${2:-}"
      shift
      ;;
    --dist)
      dist="${2:-}"
      shift
      ;;
    *)
      echo "usage: $0 [--offline] [--pull] [--env-file <path>] [--dist <path>]" >&2
      exit 2
      ;;
  esac
  shift
done

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf 'SKIP  %s\n' "$1"; }

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

compose() {
  env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    docker compose --project-directory "$root/infra" -f "$base" -f "$overlay" --env-file "$1" --profile '*' \
    config --format json
}

required_vars() {
  grep -o '\${[A-Z0-9_]*:?' "$overlay" | sed 's/^\${//; s/:?$//' | sort -u
}

template_vars() {
  sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' "$production/production.env.example" | sort -u
}

dummy_env() {
  local name
  bash "$production/cloudflare-ranges.sh" env
  while read -r name; do
    case "$name" in
      CLOUDFLARE_RANGES | API_CLOUDFLARE_RANGES) ;;
      PUBLIC_HOST) echo "PUBLIC_HOST=gerlines.invalid" ;;
      *_DIR) echo "$name=/srv/gerlines-check/$(tr "[:upper:]" "[:lower:]" <<<"$name")" ;;
      *) echo "$name=$(openssl rand -hex 16)" ;;
    esac
  done < <(required_vars)
}

for tool in docker node openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is not installed"
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose is not available"
  exit 1
fi

missing_in_template="$(comm -23 <(required_vars) <(template_vars) | paste -sd ' ' -)"
if [[ -z "$missing_in_template" ]]; then
  pass "every required variable of the overlay is listed in infra/production/production.env.example"
else
  fail "production.env.example lacks $missing_in_template"
fi

defaulted="$(grep -o -E '(^|[^$])\$\{[^}]*\}' "$overlay" | sed -E 's/^[^$]//' |
  grep -v -E '^\$\{[A-Z0-9_]+:\?[^}]*\}$' | grep -v -x -F '${PREDICTION_TABLE:-}' | sort -u | paste -sd ' ' -)"
if [[ -z "$defaulted" ]]; then
  pass "the overlay defaults no variable (each is required with :?, PREDICTION_TABLE may stay empty)"
else
  fail "the overlay defaults $defaulted"
fi

if [[ -n "$env_file" ]]; then
  if [[ ! -f "$env_file" ]]; then
    fail "env file $env_file not found"
    exit 1
  fi
  render_env="$env_file"
  label="the env file"
else
  render_env="$work/dummy.env"
  dummy_env >"$render_env"
  label="dummy values"
fi

if compose "$render_env" >"$work/rendered.json" 2>"$work/render.err"; then
  pass "the overlay renders with $label (docker compose config, every profile)"
else
  fail "the overlay does not render with $label: $(grep -o 'required variable [A-Z0-9_]* is missing' "$work/render.err" | head -3 | paste -sd ',' -)"
  exit 1
fi

if [[ -z "$env_file" ]]; then
  refused=0
  accepted=""
  while read -r name; do
    for variant in unset empty; do
      if [[ "$variant" == unset ]]; then
        grep -v "^$name=" "$render_env" >"$work/negative.env"
      else
        sed "s|^$name=.*|$name=|" "$render_env" >"$work/negative.env"
      fi
      if compose "$work/negative.env" >/dev/null 2>"$work/negative.err" ||
        ! grep -q "$name" "$work/negative.err"; then
        accepted="$accepted $name($variant)"
      else
        refused=$((refused + 1))
      fi
    done
  done < <(required_vars)
  if [[ -z "$accepted" ]]; then
    pass "each of the $((refused / 2)) required variables stops the render when unset or empty"
  else
    fail "the render goes on without:$accepted"
  fi
fi

node --input-type=module - "$work/rendered.json" "$production" "$root" "${env_file:+real}" <<'JS'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [renderedPath, production, root, mode] = process.argv.slice(2);
const config = JSON.parse(readFileSync(renderedPath, "utf8"));
const services = config.services ?? {};
let failed = 0;
const check = (ok, text, detail = "") => {
  if (ok) console.log(`PASS  ${text}`);
  else {
    failed += 1;
    console.log(`FAIL  ${text}${detail ? `: ${detail}` : ""}`);
  }
};
const env = (name) => services[name]?.environment ?? {};
const names = Object.keys(services).sort();

const published = names.filter((name) => (services[name].ports ?? []).length > 0);
check(
  published.length === 1 && published[0] === "edge",
  "only edge publishes a port",
  `published by ${published.join(", ") || "none"}`,
);
const edgePorts = services.edge?.ports ?? [];
check(
  edgePorts.length === 1 &&
    edgePorts[0].target === 443 &&
    String(edgePorts[0].published) === "443" &&
    edgePorts[0].protocol === "tcp" &&
    edgePorts[0].host_ip === "0.0.0.0",
  "edge publishes 443/tcp on IPv4 only",
  JSON.stringify(edgePorts),
);

const hostShared = names.filter(
  (name) =>
    services[name].network_mode === "host" ||
    services[name].privileged === true ||
    services[name].pid === "host" ||
    services[name].ipc === "host",
);
check(hostShared.length === 0, "no service shares the host's network, pid or ipc, none is privileged", hostShared.join(", "));

const unpinned = names.filter((name) => !services[name].build && !/@sha256:[0-9a-f]{64}$/.test(services[name].image ?? ""));
check(unpinned.length === 0, "every pulled image is pinned by digest", unpinned.join(", "));

const hardened = ["api", "edge", "live", "recorder", "realtime", "router"];
const soft = hardened.filter(
  (name) =>
    services[name]?.read_only !== true ||
    !(services[name]?.cap_drop ?? []).includes("ALL") ||
    !(services[name]?.security_opt ?? []).includes("no-new-privileges:true"),
);
check(soft.length === 0, "app services run read-only, without capabilities, without new privileges", soft.join(", "));

const placeholder = [];
for (const name of names) {
  for (const [key, value] of Object.entries(env(name))) {
    if (typeof value === "string" && /change-me/i.test(value)) placeholder.push(`${name}.${key}`);
  }
}
check(placeholder.length === 0, "no placeholder secret (change-me) in any service", placeholder.join(", "));

const devFlags = [];
const retired = [];
const truthy = (value) => value !== undefined && value !== null && !["", "0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
for (const name of names) {
  const values = env(name);
  for (const [key, value] of Object.entries(values)) {
    if (/^(LIVE_LOCAL_STACK|VEHICLE_SEQUENCE_ENABLED)$/.test(key) && truthy(value)) devFlags.push(`${name}.${key}`);
    if (/^VITE_/.test(key)) devFlags.push(`${name}.${key}`);
    if (/^(API_DEV_ROUTES|TRANSITOUS_)/.test(key)) retired.push(`${name}.${key}`);
    if (/^CENTRIFUGO_(ADMIN|.*INSECURE|DEBUG|SWAGGER|PROMETHEUS)/.test(key)) devFlags.push(`${name}.${key}`);
  }
}
if (env("api").NODE_ENV !== "production") devFlags.push("api.NODE_ENV is not production");
check(devFlags.length === 0, "no dev flag (local stack, admin, insecure, coach sequence, Vite)", devFlags.join(", "));
check(retired.length === 0, "no retired variable (API_DEV_ROUTES, TRANSITOUS_*: the dev trips proxy is gone)", retired.join(", "));

const networks = config.networks ?? {};
check(networks.backend?.internal === true, "the backend network is internal (no route out)");
const backendOnly = ["db", "valkey", "router", "realtime"];
const exposed = backendOnly.filter((name) => {
  const joined = Object.keys(services[name]?.networks ?? {});
  return joined.length !== 1 || joined[0] !== "backend";
});
check(exposed.length === 0, "db, valkey, router and realtime join only the backend network", exposed.join(", "));
const onEdge = names.filter((name) => Object.keys(services[name].networks ?? {}).includes("edge"));
check(onEdge.length === 1 && onEdge[0] === "edge", "only edge joins the routed edge network", onEdge.join(", "));
check(networks.front?.internal === true, "the front network between edge and api, live, centrifugo is internal");
const frontSide = ["api", "live", "centrifugo"].filter((name) => {
  const joined = Object.keys(services[name]?.networks ?? {}).sort().join(",");
  return joined !== "backend,front";
});
check(frontSide.length === 0, "api, live and centrifugo join only front and backend (no route out)", frontSide.join(", "));

const confined = ["db", "valkey", "centrifugo"].filter(
  (name) =>
    !(services[name]?.cap_drop ?? []).includes("ALL") ||
    !(services[name]?.security_opt ?? []).includes("no-new-privileges:true") ||
    (services[name]?.cap_add ?? []).some((cap) => !["CHOWN", "SETUID", "SETGID"].includes(cap)),
);
check(confined.length === 0, "db, valkey and centrifugo drop every capability (valkey keeps CHOWN, SETUID, SETGID to step down) and gain no privileges", confined.join(", "));

const apiUser = /^postgres:\/\/([^:]+):/.exec(env("api").SEARCH_DATABASE_URL ?? "")?.[1];
check(apiUser !== undefined && apiUser !== env("db").POSTGRES_USER, "the API reads with its own database role, not the owner");
const apiDatabases = ["SEARCH_DATABASE_URL", "STATS_DATABASE_URL", "STATUS_DATABASE_URL", "VEHICLE_DATABASE_URL"].map((key) => env("api")[key]);
check(
  apiDatabases.every((url) => typeof url === "string" && url === apiDatabases[0]),
  "search, statistics, data status and vehicle identity read the same database with the API role",
);

const edgeAddress = services.edge?.networks?.front?.ipv4_address;
check(
  edgeAddress !== undefined && env("api").API_TRUSTED_PROXIES === edgeAddress,
  "API_TRUSTED_PROXIES is edge's fixed address and nothing else",
  `${env("api").API_TRUSTED_PROXIES} against ${edgeAddress}`,
);
const ranges = readFileSync(join(production, "cloudflare-ips.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
check(
  env("api").API_CLOUDFLARE_RANGES === ranges.join(","),
  `API_CLOUDFLARE_RANGES equals the ${ranges.length} ranges of cloudflare-ips.txt`,
);
check(
  env("edge").CLOUDFLARE_RANGES === ranges.join(" "),
  "edge CLOUDFLARE_RANGES equals the same ranges",
);

const valkeyCommand = (services.valkey?.command ?? []).join(" ");
check(
  /valkey-server - /.test(valkeyCommand) &&
    /requirepass \$\$?\{VALKEY_PASSWORD\}/.test(valkeyCommand) &&
    /--protected-mode yes/.test(valkeyCommand) &&
    !/--protected-mode no/.test(valkeyCommand),
  "valkey reads requirepass from stdin (not argv) with protected mode on",
);
check(
  /AUTH=/.test((services.valkey?.healthcheck?.test ?? []).join(" ")),
  "the valkey health check authenticates",
);
const valkeyUrls = ["api", "live"].map((name) => env(name).VALKEY_URL ?? "");
check(
  valkeyUrls.every((url) => /^redis:\/\/:[^@]+@valkey:6379$/.test(url)),
  "api and live reach valkey with the password",
);

const centrifugoMount = (services.centrifugo?.volumes ?? []).find((volume) => volume.target === "/centrifugo/config.json");
check(
  centrifugoMount?.source === join(production, "centrifugo.json"),
  "centrifugo reads infra/production/centrifugo.json",
  centrifugoMount?.source,
);
const centrifugo = JSON.parse(readFileSync(join(production, "centrifugo.json"), "utf8"));
const internalPort = centrifugo.http_server?.internal_port;
const namespaces = centrifugo.channel?.namespaces ?? [];
const namespace = (name) => namespaces.find((entry) => entry.name === name);
const live = namespace("live");
const train = namespace("train");
const unnamed = centrifugo.channel?.without_namespace ?? {};
const closedFields = [
  "allow_publish_for_client",
  "allow_publish_for_anonymous",
  "allow_publish_for_subscriber",
  "presence",
  "join_leave",
  "allow_presence_for_client",
  "allow_presence_for_anonymous",
  "allow_presence_for_subscriber",
  "allow_history_for_client",
  "allow_history_for_anonymous",
  "allow_history_for_subscriber",
  "allow_recovery",
];
check(
  centrifugo.admin?.enabled === false &&
    centrifugo.admin?.insecure !== true &&
    centrifugo.client?.insecure !== true &&
    centrifugo.http_api?.insecure !== true &&
    centrifugo.prometheus?.enabled !== true &&
    centrifugo.swagger?.enabled !== true &&
    centrifugo.debug?.enabled !== true,
  "centrifugo: admin off, no insecure mode, prometheus, swagger and debug off",
);
check(
  centrifugo.client?.allow_anonymous_connect_without_token === true &&
    centrifugo.client?.disallow_anonymous_connection_tokens !== true &&
    live?.allow_subscribe_for_anonymous === true &&
    namespaces.filter((entry) => entry.allow_subscribe_for_anonymous === true).length === 1 &&
    unnamed.allow_subscribe_for_anonymous !== true,
  "centrifugo: anonymous connect, anonymous subscribe only in the live namespace",
);
check(
  train !== undefined && train.allow_subscribe_for_anonymous === false,
  "centrifugo: the train namespace stays closed to anonymous clients",
);
const openFields = [...namespaces, { name: "without_namespace", ...unnamed }].flatMap((entry) =>
  closedFields
    .filter((field) => entry[field] !== false && !(entry.name === "without_namespace" && entry[field] === undefined))
    .map((field) => `${entry.name}.${field}`),
);
check(
  openFields.length === 0 && namespaces.every((entry) => entry.history_size === 0),
  "centrifugo: publish, presence, join and leave, history and recovery set to false in every namespace, no history kept",
  openFields.join(", "),
);
const clientLimits = centrifugo.client ?? {};
check(
  Number.isInteger(clientLimits.channel_limit) &&
    clientLimits.channel_limit > 0 &&
    clientLimits.channel_limit <= 8 &&
    Number.isInteger(clientLimits.connection_limit) &&
    clientLimits.connection_limit > 0 &&
    clientLimits.connection_limit <= 4000,
  "centrifugo: at most 8 channels per connection and a connection limit of at most 4,000 (256 MiB holds about 5,000, WP-9.4)",
  `channel_limit ${clientLimits.channel_limit}, connection_limit ${clientLimits.connection_limit}`,
);
check(
  internalPort !== undefined &&
    String(internalPort) !== "8000" &&
    env("live").CENTRIFUGO_URL === `http://centrifugo:${internalPort}` &&
    env("centrifugo").CENTRIFUGO_CLIENT_ALLOWED_ORIGINS === `https://${env("edge").PUBLIC_HOST}`,
  "centrifugo serves its API and health on the internal port only and admits the site's origin",
);

const caddyfile = readFileSync(join(production, "Caddyfile"), "utf8");
const caddyRules = [
  [/^\tadmin off$/m, "admin off"],
  [/^\tauto_https disable_redirects$/m, "no port 80"],
  [/trusted_proxies static \{\$CLOUDFLARE_RANGES\}/, "Cloudflare as the only trusted proxies"],
  [/client_ip_headers CF-Connecting-IP/, "client address from CF-Connecting-IP of a trusted peer"],
  [/mode require_and_verify\n\t\t\ttrust_pool file \/etc\/caddy\/tls\/origin-pull-own-ca\.pem\n/, "per-hostname Authenticated Origin Pulls with our own CA"],
  [/@notCloudflare not remote_ip \{\$CLOUDFLARE_RANGES\}/, "a matcher for peers outside Cloudflare"],
  [/request_header @notCloudflare -CF-Connecting-IP/, "CF-Connecting-IP stripped outside Cloudflare"],
  [/request_header @notCloudflare -X-Forwarded-For/, "X-Forwarded-For stripped outside Cloudflare"],
  [/handle \/api\/dev\/\* \{\n\t\trespond 404/, "/api/dev answered 404 at the edge"],
  [/^\tencode zstd gzip$/m, "on-the-fly compression for what has no precompressed copy"],
  [/handle \/assets\/\* \{\n\t\troot \* \/srv\/web\n\t\theader Cache-Control "public, max-age=31536000, immutable"\n\t\tfile_server \{\n\t\t\tprecompressed br zstd gzip\n\t\t\}\n\t\}/, "hashed assets from their precompressed copies with an immutable header and no index fallback (a missing chunk is a 404)"],
  [/\thandle \{\n\t\troot \* \/srv\/web\n\t\theader Cache-Control "no-cache"\n\t\ttry_files \{path\} \/index\.html\n\t\tfile_server \{\n\t\t\tprecompressed br zstd gzip\n\t\t\}\n\t\}/, "the pages from their precompressed copies with no-cache and the index fallback"],
];
const missingRules = caddyRules.filter(([pattern]) => !pattern.test(caddyfile)).map(([, text]) => text);
check(missingRules.length === 0, "Caddyfile: admin off, no port 80, Cloudflare trust, AOP, header stripping, no dev routes, precompressed web files", missingRules.join(", "));
check(!/^\s*debug\s*$/m.test(caddyfile) && !/\blog\b/.test(caddyfile), "Caddyfile: no debug and no access log (no addresses in logs)");

const dockerfile = readFileSync(join(root, "infra/production/api.Dockerfile"), "utf8");
check(
  /^FROM node:[^@\s]+@sha256:[0-9a-f]{64}$/m.test(dockerfile) && /^USER node$/m.test(dockerfile) && /NODE_ENV=production/.test(dockerfile),
  "api image: pinned base, non-root user, NODE_ENV=production",
);

if (mode === "real") {
  const secretNames = ["DB_OWNER_PASSWORD", "API_DB_PASSWORD", "VALKEY_PASSWORD", "CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY", "CENTRIFUGO_HTTP_API_KEY"];
  const values = {
    DB_OWNER_PASSWORD: env("db").POSTGRES_PASSWORD,
    API_DB_PASSWORD: /^postgres:\/\/[^:]+:([^@]+)@/.exec(env("api").SEARCH_DATABASE_URL ?? "")?.[1],
    VALKEY_PASSWORD: env("valkey").VALKEY_PASSWORD,
    CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY: env("centrifugo").CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY,
    CENTRIFUGO_HTTP_API_KEY: env("centrifugo").CENTRIFUGO_HTTP_API_KEY,
  };
  const weak = secretNames.filter((name) => !/^[A-Za-z0-9._~-]{32,}$/.test(values[name] ?? ""));
  check(weak.length === 0, "secrets are at least 32 URL-safe characters", weak.join(", "));
  const distinct = new Set(secretNames.map((name) => values[name]));
  check(distinct.size === secretNames.length, "every secret is different");
}

process.exit(failed === 0 ? 0 : 1);
JS
node_status=$?
if [[ $node_status -ne 0 ]]; then
  failures=$((failures + 1))
fi

if [[ -n "$env_file" ]]; then
  tls_dir="$(sed -n 's/^EDGE_TLS_DIR=//p' "$env_file" | tail -1)"
  own_ca="$tls_dir/origin-pull-own-ca.pem"
  if [[ -r "$own_ca" ]]; then
    ca_text="$(openssl x509 -in "$own_ca" -noout -subject -issuer -ext basicConstraints 2>/dev/null)"
    if [[ -z "$ca_text" ]]; then
      fail "$own_ca is not a PEM certificate"
    elif grep -qi -e 'cloudflare' -e 'origin-pull' <<<"$ca_text"; then
      fail "$own_ca is Cloudflare's shared origin pull certificate; per-hostname pulls need our own CA (runbook step 3)"
    elif ! grep -q 'CA:TRUE' <<<"$ca_text"; then
      fail "$own_ca is not a CA certificate"
    elif ! openssl x509 -in "$own_ca" -noout -checkend 2592000 >/dev/null; then
      fail "$own_ca expires within 30 days"
    else
      pass "the origin pull CA is our own CA, valid for 30 days more"
    fi
  else
    skip "origin pull CA: $own_ca is not readable here (run on the server as a user who can read EDGE_TLS_DIR)"
  fi
fi

if [[ -z "$env_file" ]]; then
  if SSH_SOURCES="192.0.2.10 2001:db8::/64" SSH_PORT=2222 bash "$production/firewall.sh" print >"$work/rules.nft" 2>"$work/rules.err" &&
    prerouting="$(sed -n '/chain origin_prerouting/,/^\t}/p' "$work/rules.nft")" &&
    grep -q 'type filter hook prerouting priority -150; policy accept;' <<<"$prerouting" &&
    grep -q 'tcp dport 443 ip saddr @cloudflare_v4 accept' <<<"$prerouting" &&
    grep -q 'tcp dport 443 ip6 saddr @cloudflare_v6 accept' <<<"$prerouting" &&
    grep -q 'tcp dport 2222 ip saddr @ssh_v4 accept' <<<"$prerouting" &&
    grep -q 'tcp dport 2222 ip6 saddr @ssh_v6 accept' <<<"$prerouting" &&
    [[ "$(grep -v -E '^\s*$' <<<"$prerouting" | tail -2 | head -1 | tr -d '\t')" == "ct state new drop" ]] &&
    [[ $(grep -c -E 'accept$' <<<"$prerouting") -eq 8 ]] &&
    grep -q 'type filter hook input priority 0; policy drop;' "$work/rules.nft" &&
    ! grep -q 'flush ruleset' "$work/rules.nft" &&
    [[ $(grep -c -E '^[0-9a-f.:]+/[0-9]+$' <(grep -v '^#' "$production/cloudflare-ips.txt")) -eq \
      $(grep -o -E '[0-9a-f.:]+/[0-9]+' <(grep 'elements' "$work/rules.nft" | head -2) | wc -l | tr -d ' ') ]]; then
    pass "firewall.sh print: on the public interface every new connection dropped but 443 from every Cloudflare range and SSH_PORT from SSH_SOURCES (before Docker's DNAT), input dropped, no flush ruleset"
  else
    fail "firewall.sh print: $(head -1 "$work/rules.err")"
  fi
  if SSH_SOURCES="0.0.0.0/0" bash "$production/firewall.sh" print >/dev/null 2>&1 ||
    SSH_SOURCES="192.0.2.10" SSH_PORT=443 bash "$production/firewall.sh" print >/dev/null 2>&1; then
    fail "firewall.sh accepts SSH from every address or on 443"
  else
    pass "firewall.sh refuses SSH from every address and SSH on 443"
  fi
  unit="$production/gerlines-firewall.service"
  if [[ -f "$unit" ]] && grep -qx 'ExecStart=/usr/sbin/nft -f /etc/gerlines/firewall.nft' "$unit" &&
    grep -qx 'ExecStop=/usr/sbin/nft delete table inet gerlines_origin' "$unit" &&
    grep -q '^Before=network-pre.target' "$unit" && ! grep -q 'nftables.conf' <(grep -v '^#' "$unit"); then
    pass "gerlines-firewall.service loads its own table before the network, apart from nftables.conf"
  else
    fail "gerlines-firewall.service missing or not loading /etc/gerlines/firewall.nft on its own"
  fi
fi

image_ready() {
  if docker image inspect "$1" >/dev/null 2>&1; then
    return 0
  fi
  if [[ $pull -eq 1 ]]; then
    docker pull -q "$1" >/dev/null
    return $?
  fi
  return 1
}

if [[ $offline -eq 1 ]]; then
  skip "container checks (--offline): caddy validate, edge header probe, centrifugo checkconfig"
elif [[ -n "$env_file" ]]; then
  skip "container checks run with dummy values only (run without --env-file)"
else
  if image_ready "$caddy_image"; then
    tls="$work/tls"
    mkdir -p "$tls"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj "/CN=gerlines.invalid" \
      -keyout "$tls/origin.key" -out "$tls/origin.pem" >/dev/null 2>&1
    cp "$tls/origin.pem" "$tls/origin-pull-own-ca.pem"
    chmod 644 "$tls/origin.key"
    ranges_space="$(bash "$production/cloudflare-ranges.sh" env | sed -n 's/^CLOUDFLARE_RANGES=//p')"
    if docker run --rm --network none --pull never -e PUBLIC_HOST=gerlines.invalid -e "CLOUDFLARE_RANGES=$ranges_space" \
      -v "$production/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$tls:/etc/caddy/tls:ro" "$caddy_image" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$work/validate.log" 2>&1; then
      pass "caddy validate ($caddy_image)"
    else
      fail "caddy validate: $(grep -i -m1 -E 'error|invalid' "$work/validate.log")"
    fi

    probe="$work/probe"
    mkdir -p "$probe/web"
    echo '<!doctype html><title>probe</title>' >"$probe/web/index.html"
    mkdir -p "$probe/web/assets"
    printf 'plain-copy' >"$probe/web/assets/app.js"
    printf 'brotli-copy' >"$probe/web/assets/app.js.br"
    printf 'zstd-copy' >"$probe/web/assets/app.js.zst"
    printf 'gzip-copy' >"$probe/web/assets/app.js.gz"
    printf '<!doctype html><title>br</title>' >"$probe/web/index.html.br"
    head -c 4096 /dev/zero | tr '\0' 'a' >"$probe/web/assets/data.json"
    awk '
      /^\tservers :443 \{/ { sub(/servers :443/, "servers") }
      /^https:\/\/\{\$PUBLIC_HOST\} \{/ { print "http://127.0.0.1:8080 {"; next }
      /^\ttls / { skipping = 1; next }
      skipping && /^\t\}$/ { skipping = 0; next }
      skipping { next }
      { gsub(/reverse_proxy (api:8787|live:8790|centrifugo:8000)/, "reverse_proxy 127.0.0.1:9000") }
      { print }
      END {
        print ""
        print "http://127.0.0.1:9000 {"
        print "\trespond \"xff=[{header.X-Forwarded-For}] cf=[{header.CF-Connecting-IP}] xri=[{header.X-Real-IP}]\""
        print "}"
      }
    ' "$production/Caddyfile" >"$probe/Caddyfile"
    probe_run() {
      docker run --rm --network none --pull never -e PUBLIC_HOST=gerlines.invalid -e "CLOUDFLARE_RANGES=$1" \
        -v "$probe/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$probe/web:/srv/web:ro" --entrypoint /bin/sh "$caddy_image" -c '
          caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || exit 3
          for attempt in 1 2 3 4 5 6 7 8 9 10; do
            wget -q -O /dev/null http://127.0.0.1:8081/healthz 2>/dev/null && break
            sleep 0.3
          done
          forged="--header X-Forwarded-For:6.6.6.6 --header CF-Connecting-IP:7.7.7.7 --header X-Real-IP:8.8.8.8"
          printf "api %s\n" "$(wget -q -O - $forged http://127.0.0.1:8080/api/v1/status)"
          printf "dev %s\n" "$(wget -S -q -O /dev/null http://127.0.0.1:8080/api/dev/transitous/trips 2>&1 | grep -m1 HTTP/ | tr -s " ")"
          printf "web %s\n" "$(wget -q -O - http://127.0.0.1:8080/stats/today)"
          for accept in "br, zstd, gzip" "zstd, gzip" "gzip"; do
            printf "pre [%s] %s\n" "$accept" "$(wget -q -O - --header "Accept-Encoding: $accept" http://127.0.0.1:8080/assets/app.js)"
          done
          printf "pre [none] %s\n" "$(wget -q -O - http://127.0.0.1:8080/assets/app.js)"
          printf "enc %s\n" "$(wget -S -q -O /dev/null --header "Accept-Encoding: gzip" http://127.0.0.1:8080/assets/data.json 2>&1 | grep -m1 -i content-encoding | tr -d "\r" | tr -s " ")"
          headers() {
            printf "== %s\n" "$1"
            wget -S -q -O /dev/null --header "Accept-Encoding: $2" "$3" 2>&1 | tr -d "\r" | tr -s " "
          }
          headers asset-br "br" http://127.0.0.1:8080/assets/app.js
          headers asset-gzip "gzip" http://127.0.0.1:8080/assets/app.js
          headers asset-missing "br" http://127.0.0.1:8080/assets/gone.js
          headers page "br" http://127.0.0.1:8080/
          printf "chrome %s\n" "$(wget -q -O - --header "Accept-Encoding: gzip, deflate, br, zstd" http://127.0.0.1:8080/assets/app.js)"
        '
    }
    outside="$(probe_run "$ranges_space" 2>&1)"
    through="$(probe_run "$ranges_space 127.0.0.1/32" 2>&1)"
    if grep -qx 'api xff=\[127.0.0.1\] cf=\[\] xri=\[\]' <<<"$outside"; then
      pass "edge probe: a peer outside Cloudflare loses CF-Connecting-IP, X-Real-IP and its forged X-Forwarded-For"
    else
      fail "edge probe outside Cloudflare: $(grep '^api' <<<"$outside")"
    fi
    if grep -qx 'api xff=\[6.6.6.6, 127.0.0.1\] cf=\[7.7.7.7\] xri=\[8.8.8.8\]' <<<"$through"; then
      pass "edge probe: a Cloudflare peer keeps CF-Connecting-IP and is appended to X-Forwarded-For"
    else
      fail "edge probe through Cloudflare: $(grep '^api' <<<"$through")"
    fi
    if grep -q '^dev .*404' <<<"$outside" && grep -q '^web <!doctype html><title>probe</title>' <<<"$outside"; then
      pass "edge probe: /api/dev answers 404, other paths fall back to the web index"
    else
      fail "edge probe routes: $(grep -E '^(dev|web)' <<<"$outside" | paste -sd ' ' -)"
    fi
    if grep -qx 'pre \[br, zstd, gzip\] brotli-copy' <<<"$outside" && grep -qx 'pre \[zstd, gzip\] zstd-copy' <<<"$outside" \
      && grep -qx 'pre \[gzip\] gzip-copy' <<<"$outside" && grep -qx 'pre \[none\] plain-copy' <<<"$outside" \
      && grep -qi '^enc  Content-Encoding: gzip' <<<"$outside"; then
      pass "edge probe: web files come from their brotli, zstd or gzip copy by Accept-Encoding, the plain file without one, and a file with no copy is compressed on the fly"
    else
      fail "edge probe precompressed files: $(grep -E '^(pre|enc)' <<<"$outside" | paste -sd ' ' -)"
    fi
    block() { awk -v name="$1" '/^== / { on = ($2 == name); next } on' <<<"$outside"; }
    asset_br="$(block asset-br)"
    asset_gzip="$(block asset-gzip)"
    etag_br="$(grep -i -m1 '^ ETag:' <<<"$asset_br")"
    etag_gzip="$(grep -i -m1 '^ ETag:' <<<"$asset_gzip")"
    if grep -qi '^ Content-Type: text/javascript' <<<"$asset_br" && grep -qi '^ Content-Encoding: br' <<<"$asset_br" \
      && grep -qi '^ Vary:.*Accept-Encoding' <<<"$asset_br" && grep -qi '^ Cache-Control: public, max-age=31536000, immutable' <<<"$asset_br" \
      && [[ -n "$etag_br" && -n "$etag_gzip" && "$etag_br" != "$etag_gzip" ]]; then
      pass "edge probe: a precompressed asset keeps its JavaScript Content-Type, says Vary Accept-Encoding, is immutable and has its own ETag per encoding"
    else
      fail "edge probe asset headers: $(paste -sd '|' - <<<"$asset_br") / etags [$etag_br] [$etag_gzip]"
    fi
    if grep -qx 'chrome brotli-copy' <<<"$outside"; then
      pass "edge probe: Chrome's Accept-Encoding (gzip, deflate, br, zstd) gets the brotli copy"
    else
      fail "edge probe Chrome Accept-Encoding: $(grep '^chrome' <<<"$outside")"
    fi
    missing="$(block asset-missing)"
    page="$(block page)"
    if grep -q ' 404 ' <<<"$(head -1 <<<"$missing")" && ! grep -qi 'immutable' <<<"$missing" \
      && grep -qi '^ Cache-Control: no-cache' <<<"$page" && grep -qi '^ Content-Type: text/html' <<<"$page"; then
      pass "edge probe: a missing hashed asset is a 404 that is not cached as immutable, the page is no-cache HTML"
    else
      fail "edge probe missing asset and page: $(paste -sd '|' - <<<"$missing") / $(paste -sd '|' - <<<"$page")"
    fi
  else
    fail "Caddy image $caddy_image is not present (rerun with --pull, or --offline to skip)"
  fi

  if image_ready "$centrifugo_image"; then
    if docker run --rm --network none --pull never -v "$production/centrifugo.json:/centrifugo/config.json:ro" \
      "$centrifugo_image" centrifugo checkconfig --config /centrifugo/config.json >"$work/centrifugo.log" 2>&1; then
      pass "centrifugo checkconfig ($centrifugo_image)"
    else
      fail "centrifugo checkconfig: $(head -1 "$work/centrifugo.log")"
    fi
  else
    fail "Centrifugo image $centrifugo_image is not present (rerun with --pull, or --offline to skip)"
  fi
fi

if [[ -n "$dist" ]]; then
  if stale="$(node "$root/apps/web/vite/check-sidecars.ts" "$dist" 2>&1)"; then
    pass "web build $dist: every .br, .zst and .gz decodes to the file beside it"
  else
    fail "web build $dist: stale or unreadable precompressed copies: $(paste -sd ' ' - <<<"$stale")"
  fi
fi

if [[ $failures -eq 0 ]]; then
  echo "check-deploy: all checks passed"
  exit 0
fi
echo "check-deploy: $failures check group(s) failed"
exit 1
