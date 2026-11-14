#!/usr/bin/env bash
# Runs once when the container is created: local env files, dependency trees,
# and the dev database is left to `pnpm dev` (through db:setup), so a create
# never blocks on a drizzle prompt and never writes to a database the caller
# has not chosen yet.
set -euo pipefail
cd "$(dirname "$0")/.."

for d in apps/web apps/data apps/native packages/db; do
    if [ ! -f "$d/.env" ]; then
        cp "$d/.env.example" "$d/.env"
    fi
done

# Better Auth wants a signing secret even when auth is disabled.
if grep -q '^BETTER_AUTH_SECRET=$' apps/web/.env; then
    secret="$(openssl rand -base64 32)"
    sed -i "s|^BETTER_AUTH_SECRET=$|BETTER_AUTH_SECRET=${secret}|" apps/web/.env
fi

# Dependencies are mounted as fresh volumes, so they start root-owned. Hand
# them to the dev user once; the host's own trees are never touched because
# they are not mounted into this container.
sudo chown -R node:node \
    node_modules \
    apps/web/node_modules \
    apps/native/node_modules \
    packages/db/node_modules \
    scripts/node_modules \
    apps/data/.venv

# CI=1 keeps pnpm and uv non-interactive; there is no TTY during a create.
CI=1 pnpm bootstrap
