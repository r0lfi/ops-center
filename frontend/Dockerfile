# --- Build stage: official upstream Node image (build tool only, not shipped) ---
FROM node:22.14-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage: custom application container -> AlmaLinux 10.2 base ---
FROM almalinux:10.2

RUN dnf -y upgrade && \
    dnf -y install nginx curl && \
    dnf clean all && \
    rm -rf /var/cache/dnf

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Runtime dirs nginx needs to write to when running as non-root on an unprivileged port.
RUN mkdir -p /var/lib/nginx/tmp /var/log/nginx /run/nginx && \
    chown -R nginx:nginx /var/lib/nginx /var/log/nginx /run/nginx /usr/share/nginx/html /etc/nginx

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=10s \
    CMD curl -fsS http://localhost:8080/healthz || exit 1

# Release metadata, stamped by .github/workflows/release.yml. Declared last so a
# new version does not invalidate the cached layers above. The defaults mark a
# local build as a development build instead of letting it claim a release.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Ops Center frontend" \
      org.opencontainers.image.description="Ops Center web interface served by Nginx" \
      org.opencontainers.image.source="https://github.com/r0lfi/ops-center" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

CMD ["nginx", "-g", "daemon off;"]
