#!/usr/bin/env bash
# Downloads the pinned MOTIS release for this machine into data/router/bin and verifies its sha256.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

version="${MOTIS_VERSION:-v2.11.4}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset="motis-macos-arm64.tar.bz2"; sha256="02753c7e6487beaede33b7ea1b37e6349cb5387de8be8c35be7137d55c7da9d7"; size=47568153 ;;
  Linux-x86_64) asset="motis-linux-amd64.tar.bz2"; sha256="b521bb29c961a3b994ff4dac663778ba64fee7b4cfaf3f2b20ff1d5e1d15e0dc"; size=52862254 ;;
  Linux-aarch64) asset="motis-linux-arm64.tar.bz2"; sha256="76f41df5bb4db14ccd163dad0a23dd85bebbb9f21a9736834e9b3d4201080f3b"; size=52378950 ;;
  *) die "no pinned MOTIS asset for $(uname -s)-$(uname -m)" ;;
esac
[[ "$version" == "v2.11.4" ]] || die "checksums are pinned for v2.11.4 only, got $version"

dest="$ROUTER_DATA/bin/motis-$version"
archive="$ROUTER_DATA/downloads/$asset"
mkdir -p "$ROUTER_DATA/downloads" "$dest"

verify() { [[ -f "$archive" ]] && [[ "$(stat -f%z "$archive" 2>/dev/null || stat -c%s "$archive")" == "$size" ]] && [[ "$(shasum -a 256 "$archive" | cut -d' ' -f1)" == "$sha256" ]]; }

if ! verify; then
  curl --fail --silent --show-error --location --retry 3 --continue-at - --output "$archive" \
    "https://github.com/motis-project/motis/releases/download/$version/$asset" || true
  verify || { rm -f "$archive"; die "download of $asset failed size or sha256 check, rerun to retry"; }
fi
echo "verified $asset sha256 $sha256 size $size"

tar -xjf "$archive" -C "$dest"
motis_bin="$(find "$dest" -type f -name motis -perm -u+x | head -n 1)"
[[ -n "$motis_bin" ]] || die "no motis executable inside $asset"
ln -sfn "$motis_bin" "$ROUTER_DATA/bin/motis"
"$ROUTER_DATA/bin/motis" --version
