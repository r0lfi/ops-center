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

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
