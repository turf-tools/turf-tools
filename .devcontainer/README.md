# Dev container

A self-contained environment for the web app, the mobile app, and the data
pipeline. The only host requirement is Docker or Podman.

Included:

- Node 22 and the pnpm version pinned in `package.json` (via corepack)
- Python 3.13 and `uv`, for `apps/data`
- `osmium-tool` (OSM geocoding), Quickwit 0.9.3 (search), Graphviz (DAG
  visualizations), `psql`, `jq`
- Postgres, defined once in `../docker-compose.dev.yml` and reused here

## Start

VS Code: **Reopen in Container**.

CLI:

```bash
devcontainer up --workspace-folder .

# Podman instead of Docker:
devcontainer up --workspace-folder . --docker-path podman
```

On create, `.devcontainer/post-create.sh` copies the `.env.example` files to
`.env`, generates a `BETTER_AUTH_SECRET` when one is missing, and runs
`pnpm bootstrap`.

Then, inside the container:

```bash
pnpm dev
```

The first `dev` pushes the Drizzle schema, seeds reference data, creates the mock
organizations, and provisions the Quickwit metastore, then starts web, native,
data, and search. Ports 3000, 7280, 8000, and 8081 are forwarded automatically.

## How the database is wired

`devcontainer.json` layers this directory's compose file on top of the repo's
`../docker-compose.dev.yml`, so the database definition has one source of truth.
The app service sets:

```
DB_HOST=postgres
DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
QW_METASTORE_URI=postgres://postgres:postgres@postgres:5432/quickwit
```

and the Postgres service drops its host port publish with `ports: !reset []`.
That keeps host port 5432 free for an existing database, and the container's
database is only reachable on the compose network.

`scripts/ensure-postgres.mjs` is what makes the same commands work in both
modes. It probes `DB_HOST:5432` first: on the host it starts the dev container
if needed, inside the dev container it finds the database already up and skips
straight to the app services.

Requires Compose with `!reset` support (2.24+, or a recent `podman-compose`).

## Authentication

`AUTH_DISABLED=1` is **not** set for you. The upstream README suggests it for
local development; uncomment it in `apps/web/.env` if you want to skip the
magic-link flow. Without it, the login link is written to the web server's
console.

## Environment variables

The compose service environment overrides whatever is in `apps/*/.env` (the
process environment always wins over the files), so a `DATABASE_URL` left in
`apps/web/.env` for host-native runs does not affect the container.

## Map tiles

`VITE_MAPTILER_KEY` in `apps/web/.env` is only needed for custom basemap styles.
With it unset the map uses MapTiler's public `streets-v4` style.

## Notes

- The container runs as `node` (uid 1000). A host user with a different uid can
  see file-ownership differences through the bind mount.
- The Postgres service runs as container root (`user: "0:0"`), which is the
  image default under Docker and is required under rootless Podman with
  `userns = "keep-id"`.
- `QW_LISTEN_ADDRESS=0.0.0.0` is set because Quickwit's `node.yaml` binds
  loopback by default, which forwarded ports cannot reach.
- `security_opt: label=disable` lets the bind mount work on SELinux hosts
  (Fedora, RHEL) without relabeling your workspace.
- Wiping the database is a host-side operation:
  `docker compose -f docker-compose.dev.yml down -v`. Inside the container
  `pnpm db:clear` has no runtime to do it with.
- `dev:ios` is unavailable in the container, since it needs Xcode.
