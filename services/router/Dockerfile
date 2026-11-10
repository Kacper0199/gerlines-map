# MOTIS server image from the pinned GitHub release binary, checked against the release sha256.
# Build context: services/router (infra/compose.yaml service router does this). The image holds no timetable data:
# compose mounts an imported data dir read-only at /data and a container config over /data/config.yml.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS download
ARG TARGETARCH
ARG MOTIS_VERSION=v2.11.4
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bzip2 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN set -eu; \
  case "$TARGETARCH" in \
    arm64) asset=motis-linux-arm64.tar.bz2; sha256=76f41df5bb4db14ccd163dad0a23dd85bebbb9f21a9736834e9b3d4201080f3b ;; \
    amd64) asset=motis-linux-amd64.tar.bz2; sha256=b521bb29c961a3b994ff4dac663778ba64fee7b4cfaf3f2b20ff1d5e1d15e0dc ;; \
    *) echo "no pinned MOTIS asset for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  test "$MOTIS_VERSION" = v2.11.4; \
  curl --fail --silent --show-error --location --retry 3 --output motis.tar.bz2 \
    "https://github.com/motis-project/motis/releases/download/$MOTIS_VERSION/$asset"; \
  echo "$sha256  motis.tar.bz2" | sha256sum --check --strict; \
  mkdir /opt/motis; \
  tar -xjf motis.tar.bz2 -C /opt/motis; \
  test -x /opt/motis/motis; \
  rm -rf /opt/motis/tiles-profiles

FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home motis
COPY --from=download /opt/motis /opt/motis
USER motis
WORKDIR /tmp
EXPOSE 8080
ENTRYPOINT ["/opt/motis/motis"]
CMD ["server", "--data", "/data"]
