#!/usr/bin/env bash
# Runs once when the container is created: local env files and dependencies.
# The database is set up by `pnpm dev` (through db:setup), not here, so a
# create never blocks on a drizzle prompt and never writes to a database the
# caller has not chosen yet.
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

# CI=1 lets pnpm purge a node_modules built outside the container (the bind
# mount may already hold one) without prompting, and there is no TTY here.
CI=1 pnpm bootstrap
