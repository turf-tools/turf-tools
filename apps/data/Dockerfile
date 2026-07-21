# Data server image. Build from the repo root:
#   docker build -f apps/data/Dockerfile -t turf-tools-data .
FROM ghcr.io/astral-sh/uv:0.11-python3.13-trixie-slim

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# The server shells out to the Quickwit CLI for `tool local-ingest`, so the
# binary ships here alongside the searcher's own image.
ARG QUICKWIT_VERSION=0.8.2
ARG TARGETARCH
# osmium filters and exports the OSM extract during geocoding.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) QW_ARCH=x86_64 ;; \
         arm64) QW_ARCH=aarch64 ;; \
         *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/quickwit-oss/quickwit/releases/download/v${QUICKWIT_VERSION}/quickwit-v${QUICKWIT_VERSION}-${QW_ARCH}-unknown-linux-gnu.tar.gz" \
       | tar -xz -C /tmp \
    && mv "/tmp/quickwit-v${QUICKWIT_VERSION}/quickwit" /usr/local/bin/quickwit \
    && rm -rf "/tmp/quickwit-v${QUICKWIT_VERSION}" \
    && quickwit --version

# Dependencies first so code edits don't invalidate the install layer.
COPY apps/data/pyproject.toml apps/data/uv.lock ./
RUN uv sync --locked --no-install-project

COPY apps/data/ ./
RUN uv sync --locked

ENV PATH="/app/.venv/bin:$PATH"

# Bake the DuckDB extensions into the image so a cold container doesn't
# reach out to the extension repository on first query.
RUN python -c "\
import duckdb; c = duckdb.connect();\
[c.install_extension(e) for e in ('ducklake', 'httpfs', 'postgres', 'spatial')]" \
    && cp -r /root/.duckdb /app/.duckdb
ENV HOME=/app

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
