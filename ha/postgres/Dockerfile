# Keep the same PostgreSQL major version as the standalone distribution.
FROM docker.io/library/postgres:17.6-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/patroni && \
    /opt/patroni/bin/pip install --no-cache-dir 'patroni[etcd3]==4.0.5' 'psycopg[binary]==3.3.4'
COPY entrypoint.sh /usr/local/bin/ha-entrypoint
RUN chmod 755 /usr/local/bin/ha-entrypoint
ENTRYPOINT ["/usr/local/bin/ha-entrypoint"]
