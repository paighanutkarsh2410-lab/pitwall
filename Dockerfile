# The replayer: streams a downloaded race as events. Races live in /data (mount a volume).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PITWALL_HOME=/data

# Take Debian's security fixes now rather than waiting for the base image to be rebuilt.
RUN apt-get update     && apt-get upgrade -y --no-install-recommends     && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/pitwall
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install . \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin pitwall \
    && mkdir -p /data && chown 10001:10001 /data

USER 10001
ENTRYPOINT ["pitwall"]
CMD ["--help"]
