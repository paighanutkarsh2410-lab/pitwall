# Pitwall: every service (pitwall service <name>), the replayer CLI and the pit-wall screen.

# ---- The screen ---------------------------------------------------------------------------
FROM node:24.22.1-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY web/ ./
RUN npm run build

# ---- The services -------------------------------------------------------------------------
FROM python:3.12-slim

LABEL org.opencontainers.image.source="https://github.com/paighanutkarsh2410-lab/pitwall" \
      org.opencontainers.image.description="Pitwall: real race telemetry streamed live, and the pit wall that shows it"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PITWALL_HOME=/data \
    PITWALL_WEB_DIST=/srv/pitwall/web

# Take Debian's security fixes now rather than waiting for the base image to be rebuilt.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/pitwall
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install . \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin pitwall \
    && mkdir -p /data && chown 10001:10001 /data
COPY --from=web /web/dist ./web

USER 10001
EXPOSE 8080
ENTRYPOINT ["pitwall"]
CMD ["--help"]
