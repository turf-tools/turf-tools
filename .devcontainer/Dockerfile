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

# Android build toolchain. The emulator itself runs on the host (it needs
# /dev/kvm), but the APK is built here: JDK 17 for Gradle, plus the SDK
# platform and build tools Expo compiles against. Gradle downloads the NDK and
# CMake on first build, which is fine because the licences are pre-accepted.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk
ARG ANDROID_CMDLINE_TOOLS=13114758
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -sSL -o /tmp/cmdline-tools.zip \
        "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
    && mv /tmp/cmdline-tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
    && rm -rf /tmp/cmdline-tools /tmp/cmdline-tools.zip \
    && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses > /dev/null \
    && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
        "platform-tools" \
        "platforms;${ANDROID_PLATFORM}" \
        "build-tools;${ANDROID_BUILD_TOOLS}" \
    && chown -R node:node "$ANDROID_HOME"
ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# pnpm is pinned in package.json; corepack fetches that version on first use.
RUN corepack enable
