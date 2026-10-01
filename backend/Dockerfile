# Custom application container -> AlmaLinux 10.2 base per project policy.
FROM almalinux:10.2

# Keep the base image current at build time, then drop package metadata.
RUN dnf -y upgrade && \
    dnf -y install python3 shadow-utils && \
    dnf clean all && \
    rm -rf /var/cache/dnf

RUN groupadd --gid 1000 opsapi && \
    useradd --uid 1000 --gid opsapi --shell /sbin/nologin --create-home opsapi

WORKDIR /app

COPY requirements.txt .
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip setuptools wheel

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R opsapi:opsapi /app

USER opsapi

EXPOSE 8000

# Release metadata, stamped by .github/workflows/release.yml. Declared last so a
# new version does not invalidate the cached layers above. The defaults mark a
# local build as a development build instead of letting it claim a release.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Ops Center API" \
      org.opencontainers.image.description="FastAPI backend and database migrations for Ops Center" \
      org.opencontainers.image.source="https://github.com/r0lfi/ops-center" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# Reported by /api/health and the OpenAPI document.
ENV APP_VERSION="${VERSION}"

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
    CMD python3 -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
