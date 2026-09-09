# Custom application container -> AlmaLinux 10.2 base per project policy.
# The trivy binary and the docker/docker-compose CLI binaries are all
# extracted from their official upstream images (not rebased - just used
# as build-time sources for single binaries, same as vendoring release
# tarballs would be). The docker CLI + compose plugin are what let
# deploy_stack() in docker_control.py shell out to a real `docker compose`
# instead of hand-rolling compose-file orchestration over the SDK.
FROM aquasec/trivy:0.72.0 AS trivy
FROM docker:27.5.1-cli AS dockercli

FROM almalinux:10.2

RUN dnf -y upgrade && \
    dnf -y install python3 shadow-utils ca-certificates && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

RUN groupadd --gid 1000 opssecurity && \
    useradd --uid 1000 --gid opssecurity --shell /sbin/nologin --create-home opssecurity

WORKDIR /app

COPY security/requirements.txt ./security-requirements.txt
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools && \
    /opt/venv/bin/pip install --no-cache-dir -r security-requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip setuptools wheel

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    TRIVY_SERVER=http://trivy-server:4954

# Shared model/config code - single source of truth, never duplicated by hand.
COPY backend/app/models ./app/models
COPY backend/app/db ./app/db
COPY backend/app/core ./app/core
RUN touch app/__init__.py

COPY security/*.py ./security/
RUN touch security/__init__.py

RUN mkdir -p /home/opssecurity/.cache/trivy /data/docker-stacks && \
    chown -R opssecurity:opssecurity /app /home/opssecurity

USER opssecurity

CMD ["celery", "-A", "security.celery_app:celery_app", "worker", "--loglevel=info", "--concurrency=1", "-Q", "security"]
