# Keep the same PostgreSQL major version as the standalone distribution.
FROM docker.io/library/postgres:17.6-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/patroni && \
    /opt/patroni/bin/pip install --no-cache-dir 'patroni[etcd3]==4.0.5' 'psycopg[binary]==3.3.4'
COPY entrypoint.sh /usr/local/bin/ha-entrypoint
RUN chmod 755 /usr/local/bin/ha-entrypoint

# Release metadata, stamped by .github/workflows/release.yml. Declared last so a
# new version does not invalidate the cached layers above. The defaults mark a
# local build as a development build instead of letting it claim a release.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Ops Center PostgreSQL HA" \
      org.opencontainers.image.description="PostgreSQL 17 with Patroni for the optional Ops Center HA deployment" \
      org.opencontainers.image.source="https://github.com/r0lfi/ops-center" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENTRYPOINT ["/usr/local/bin/ha-entrypoint"]
