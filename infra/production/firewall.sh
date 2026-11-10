#!/usr/bin/env bash
# Origin firewall of the production server (nftables, table inet gerlines_origin). Written for the deployment,
# never run on a laptop. On the public interface every new inbound connection is dropped except HTTPS from the
# Cloudflare ranges of cloudflare-ips.txt, SSH on SSH_PORT from SSH_SOURCES, ICMP and DHCP replies. The rules hook
# prerouting before Docker's DNAT (priority -150 < -100), because a published container port never reaches the input
# hook; the input chain drops the rest for the host's own sockets. It lives in its own table, so Docker's rules stay.
#   print    write the ruleset to stdout (default); /etc/gerlines/firewall.nft for gerlines-firewall.service
#   apply    check the ruleset with nft -c, load it, and put the previous table back after ROLLBACK_SECONDS (default
#            60) unless `confirm` runs first, from a new SSH session (root)
#   confirm  keep the ruleset loaded by apply (root)
#   remove   delete the table (root)
# Environment: SSH_SOURCES (comma or space separated addresses or CIDRs, IPv4 and IPv6, required), SSH_PORT
# (default 22), PUBLIC_IFACE (default eth0, the Hetzner Cloud public interface), ROLLBACK_SECONDS.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
table="gerlines_origin"
iface="${PUBLIC_IFACE:-eth0}"
ssh_port="${SSH_PORT:-22}"
rollback_seconds="${ROLLBACK_SECONDS:-60}"
state="/run/gerlines-firewall"

if [[ ! "$iface" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then
  echo "PUBLIC_IFACE must be an interface name, got $iface" >&2
  exit 2
fi
if [[ ! "$ssh_port" =~ ^[0-9]{1,5}$ ]] || ((ssh_port < 1 || ssh_port > 65535 || ssh_port == 443)); then
  echo "SSH_PORT must be a port from 1 to 65535 other than 443, got $ssh_port" >&2
  exit 2
fi
if [[ ! "$rollback_seconds" =~ ^[0-9]{1,4}$ ]] || ((rollback_seconds < 1)); then
  echo "ROLLBACK_SECONDS must be a number of seconds, got $rollback_seconds" >&2
  exit 2
fi

join_elements() {
  paste -sd ',' - | sed 's/,/, /g'
}

cloudflare="$(grep -v -e '^#' -e '^[[:space:]]*$' "$here/cloudflare-ips.txt")"
cloudflare_v4="$(grep -E '^[0-9.]+/[0-9]+$' <<<"$cloudflare" | join_elements)"
cloudflare_v6="$(grep -E '^[0-9a-f:]+/[0-9]+$' <<<"$cloudflare" | join_elements)"

ruleset() {
  local sources ssh_v4 ssh_v6
  sources="$(tr ', ' '\n\n' <<<"${SSH_SOURCES:-}" | grep -v '^$' || true)"
  if [[ -z "$sources" ]]; then
    echo "SSH_SOURCES must name the addresses allowed to reach SSH" >&2
    exit 2
  fi
  if grep -v -E '^([0-9.]+|[0-9a-fA-F:]+)(/[0-9]{1,3})?$' <<<"$sources" >/dev/null; then
    echo "SSH_SOURCES holds an entry that is not an address or CIDR" >&2
    exit 2
  fi
  if grep -E '/0+$' <<<"$sources" >/dev/null; then
    echo "SSH_SOURCES must not admit every address" >&2
    exit 2
  fi
  ssh_v4="$(grep -E '^[0-9.]+(/[0-9]+)?$' <<<"$sources" | join_elements || true)"
  ssh_v6="$(grep ':' <<<"$sources" | join_elements || true)"

  cat <<RULES
table inet $table
delete table inet $table

table inet $table {
	set cloudflare_v4 {
		type ipv4_addr
		flags interval
		elements = { $cloudflare_v4 }
	}

	set cloudflare_v6 {
		type ipv6_addr
		flags interval
		elements = { $cloudflare_v6 }
	}
RULES
  if [[ -n "$ssh_v4" ]]; then
    printf '\n\tset ssh_v4 {\n\t\ttype ipv4_addr\n\t\tflags interval\n\t\telements = { %s }\n\t}\n' "$ssh_v4"
  fi
  if [[ -n "$ssh_v6" ]]; then
    printf '\n\tset ssh_v6 {\n\t\ttype ipv6_addr\n\t\tflags interval\n\t\telements = { %s }\n\t}\n' "$ssh_v6"
  fi
  cat <<RULES

	chain origin_prerouting {
		type filter hook prerouting priority -150; policy accept;
		iifname != "$iface" accept
		ct state invalid drop
		ct state established,related accept
		tcp dport 443 ip saddr @cloudflare_v4 accept
		tcp dport 443 ip6 saddr @cloudflare_v6 accept
RULES
  if [[ -n "$ssh_v4" ]]; then printf '\t\ttcp dport %s ip saddr @ssh_v4 accept\n' "$ssh_port"; fi
  if [[ -n "$ssh_v6" ]]; then printf '\t\ttcp dport %s ip6 saddr @ssh_v6 accept\n' "$ssh_port"; fi
  cat <<RULES
		meta l4proto { icmp, ipv6-icmp } accept
		udp sport { 67, 547 } udp dport { 68, 546 } accept
		ct state new drop
	}

	chain origin_input {
		type filter hook input priority 0; policy drop;
		iifname "lo" accept
		ct state invalid drop
		ct state established,related accept
		iifname { "docker0", "br-*" } accept
		meta l4proto { icmp, ipv6-icmp } accept
		udp sport { 67, 547 } udp dport { 68, 546 } accept
RULES
  if [[ -n "$ssh_v4" ]]; then printf '\t\ttcp dport %s ip saddr @ssh_v4 accept\n' "$ssh_port"; fi
  if [[ -n "$ssh_v6" ]]; then printf '\t\ttcp dport %s ip6 saddr @ssh_v6 accept\n' "$ssh_port"; fi
  printf '\t}\n}\n'
}

apply() {
  local rules
  rules="$(ruleset)"
  nft -c -f - <<<"$rules"
  install -d -m 700 "$state"
  rm -f "$state/confirmed" "$state/rolled-back"
  if [[ -f "$state/timer.pid" ]] && kill -0 "$(cat "$state/timer.pid")" 2>/dev/null; then
    echo "an earlier apply waits for confirm; run confirm or wait for its rollback first" >&2
    exit 1
  fi
  {
    printf 'table inet %s\ndelete table inet %s\n' "$table" "$table"
    nft list table inet "$table" 2>/dev/null || true
  } >"$state/previous.nft"
  nft -f - <<<"$rules"
  setsid bash -c '
    sleep "$1"
    if [[ ! -e "$2/confirmed" ]]; then
      nft -f "$2/previous.nft" && date -u +%FT%TZ >"$2/rolled-back"
    fi
  ' rollback "$rollback_seconds" "$state" </dev/null >/dev/null 2>&1 &
  echo "$!" >"$state/timer.pid"
  echo "loaded table inet $table; it is put back in ${rollback_seconds} s unless you run: sudo bash $0 confirm (from a new SSH session)"
}

confirm() {
  if [[ -e "$state/rolled-back" ]]; then
    echo "already rolled back at $(cat "$state/rolled-back"); apply again" >&2
    exit 1
  fi
  if [[ ! -f "$state/timer.pid" ]] || ! kill -0 "$(cat "$state/timer.pid")" 2>/dev/null; then
    echo "nothing waits for confirm" >&2
    exit 1
  fi
  touch "$state/confirmed"
  kill "$(cat "$state/timer.pid")" 2>/dev/null || true
  rm -f "$state/timer.pid"
  echo "kept table inet $table; save it for boot: sudo bash $0 print > /etc/gerlines/firewall.nft (with the same environment)"
}

case "${1:-print}" in
  print) ruleset ;;
  apply) apply ;;
  confirm) confirm ;;
  remove) nft delete table inet "$table" ;;
  *)
    echo "usage: $0 [print|apply|confirm|remove]" >&2
    exit 2
    ;;
esac
