FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# osmium-tool drives the OSM geocoding pipeline, graphviz renders the Hamilton
# DAG visualizations, and psql/jq are for inspecting the dev database.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        osmium-tool \
        graphviz \
        postgresql-client \
        jq \
    && rm -rf /var/lib/apt/lists/*

# uv supplies the Python 3.13 toolchain that apps/data requires. Pinned so a
# rebuild resolves the same release; bump UV_VERSION deliberately.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy
ARG UV_VERSION=0.13.8
RUN curl -LsSf https://astral.sh/uv/install.sh \
        | UV_VERSION="${UV_VERSION}" UV_INSTALL_DIR=/usr/local/bin sh \
    && uv python install 3.13

# Quickwit binary for the search service (`pnpm dev:search`). The tarball is
# checksum-verified against the release asset for each architecture.
ARG QUICKWIT_VERSION=0.9.3
ARG QUICKWIT_SHA256_X86_64=8ffce7d904fb270aed3d0b2dc0003ec34329d5ba51d048a9d73e1d10109a8aaa
ARG QUICKWIT_SHA256_AARCH64=8f1ed37aa65d6fea46a18283910bf386d728a393d03e2e13d2c6d96f55699236
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) qw_arch=x86_64; want="$QUICKWIT_SHA256_X86_64" ;; \
        arm64) qw_arch=aarch64; want="$QUICKWIT_SHA256_AARCH64" ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
    && curl -sSL -o /tmp/quickwit.tar.gz \
        "https://github.com/quickwit-oss/quickwit/releases/download/v${QUICKWIT_VERSION}/quickwit-v${QUICKWIT_VERSION}-${qw_arch}-unknown-linux-gnu.tar.gz" \
    && echo "${want}  /tmp/quickwit.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/quickwit.tar.gz -C /opt \
    && ln -sf "/opt/quickwit-v${QUICKWIT_VERSION}/quickwit" /usr/local/bin/quickwit \
    && rm /tmp/quickwit.tar.gz \
    && quickwit --version

# pnpm is pinned in package.json; corepack fetches that version on first use.
RUN corepack enable
