# Custom application container -> AlmaLinux 10.2 base per project policy.
# Build context is the repo root (see compose.yml) so this can reuse the
# SQLAlchemy models/config defined under backend/app/ - same layout as
# worker/Dockerfile and security/Dockerfile.
FROM almalinux:10.2

RUN dnf -y upgrade && \
    dnf -y install python3 shadow-utils git && \
    dnf clean all && \
    rm -rf /var/cache/dnf

RUN groupadd --gid 1000 opsaiworker && \
    useradd --uid 1000 --gid opsaiworker --shell /sbin/nologin --create-home opsaiworker

# The read-only /repo bind mount (see compose.yml) is owned by the host
# user, not opsaiworker - git refuses to touch a repo it doesn't own
# ("dubious ownership") unless told otherwise. System-wide, not per-user,
# so it applies regardless of which uid actually runs.
RUN git config --system --add safe.directory /repo

WORKDIR /app

COPY worker_ai/requirements.txt ./worker-ai-requirements.txt
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools && \
    /opt/venv/bin/pip install --no-cache-dir -r worker-ai-requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip setuptools wheel

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# Shared model/config code from the backend image (single source of truth
# for the schema - never duplicated by hand).
COPY backend/app/models ./app/models
COPY backend/app/db ./app/db
COPY backend/app/core ./app/core
RUN touch app/__init__.py

COPY worker_ai ./worker_ai/
RUN touch worker_ai/__init__.py worker_ai/ai/__init__.py

RUN mkdir -p /app/run && chown -R opsaiworker:opsaiworker /app

USER opsaiworker

# --concurrency=4: an agent run is mostly waiting on LLM/HTTP round trips
# and Ansible-job polling, not CPU, so more than one can usefully overlap
# per worker without the zombie-process risk ops-worker has (this worker
# never shells out to ansible-runner itself).
CMD ["celery", "-A", "worker_ai.celery_app:celery_app", "worker", "--loglevel=info", "--concurrency=4", "-Q", "ai"]
