# Custom application container -> AlmaLinux 10.2 base per project policy.
# Build context is the repo root (see compose.yml) so this can reuse the
# SQLAlchemy models/config defined under backend/app/.
FROM almalinux:10.2

RUN dnf -y upgrade && \
    dnf -y install python3 shadow-utils openssh-clients sshpass && \
    dnf clean all && \
    rm -rf /var/cache/dnf

RUN groupadd --gid 1000 opsworker && \
    useradd --uid 1000 --gid opsworker --shell /sbin/nologin --create-home opsworker

WORKDIR /app

COPY worker/requirements.txt ./worker-requirements.txt
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools && \
    /opt/venv/bin/pip install --no-cache-dir -r worker-requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip setuptools wheel

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ANSIBLE_CONFIG=/app/ansible/ansible.cfg \
    ANSIBLE_PROJECT_DIR=/app/ansible/playbooks \
    ANSIBLE_ROLES_PATH=/app/ansible/roles \
    ANSIBLE_COLLECTIONS_PATH=/app/ansible/collections \
    PYTHONPATH=/app

# Shared model/config code from the backend image (kept as the single source
# of truth for the schema - never duplicated by hand).
COPY backend/app/models ./app/models
COPY backend/app/db ./app/db
COPY backend/app/core ./app/core
RUN touch app/__init__.py

COPY ansible ./ansible
COPY worker/*.py ./worker/
RUN touch worker/__init__.py

RUN mkdir -p /app/run && chown -R opsworker:opsworker /app

USER opsworker

CMD ["celery", "-A", "worker.celery_app:celery_app", "worker", "--loglevel=info", "--concurrency=2"]
