# Turf Tools

Open source canvassing platform and mobile app.

The software in this repository includes three key components: (1) performant voter file data processing (including a fully open-source geocoding pipeline) (2) a canvassing application that runs natively on iOS and Android (3) a web platform for creating segments, scripts, and campaigns, and for cutting turf.

The project is in active development and currently undergoing early testing.

## Prerequisites

You'll need to have these installed to run the development environment.

- [Node.js](https://nodejs.org/) >= 22.12
- [pnpm](https://pnpm.io/) enabled via `corepack enable`
- [Docker](https://www.docker.com/) (for the development Postgres)
- [uv](https://docs.astral.sh/uv/) `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [Quickwit](https://quickwit.io/) `curl -L https://install.quickwit.io | sh` (move binary to `/usr/local/bin/`)
- [Xcode](https://developer.apple.com/xcode/) (optional, for iOS simulator)

## Setup

Once the above are installed, run this to install both Node and Python dependencies.

```bash
pnpm bootstrap
```

Then create local env files from the committed examples:

```bash
for d in apps/web apps/data apps/native packages/db; do cp $d/.env.example $d/.env; done
```

Two things to fill in: a [MapTiler](https://www.maptiler.com/) API key (`VITE_MAPTILER_KEY` in `apps/web/.env` and `EXPO_PUBLIC_MAPTILER_KEY` in `apps/native/.env`), and `AUTH_DISABLED=1` uncommented in `apps/web/.env` to skip magic-link auth during development. Everything else works with the defaults.

## Architecture

The overall structure is as follows:

```
apps/
  web/       TanStack Start (admin UI, oRPC API, system orchestrator)
  native/    Expo/React Native (mobile canvassing app)
  data/      FastAPI + DuckDB (voter file processing, geocoding, search indexing)

packages/
  db/        Drizzle schema + Postgres client
```

We leverage a two database design to get the best of both where needed:

- **Postgres** (via Drizzle) — operational data: users, campaigns, segments, zone groups, turfs, canvass results
- **DuckLake** (via DuckDB) — analytical columnar data: voter files, persons, buildings, doors

## Development

Start all services by calling:

```bash
pnpm dev
```

This starts:

- `db` — Postgres via Docker Compose (port 5432)
- `web` — TanStack Start admin UI and oRPC API (port 3000)
- `native` — Expo web preview of the mobile app (port 8081)
- `data` — FastAPI data service (including DuckDB/DuckLake) (port 8000)
- `search` — Quickwit search engine (port 7280)

The first time you run `dev`, the web server automatically pushes the Drizzle schema and seeds reference data once Postgres is up.

To work with voter data, create a dataset in the admin UI and import it from a source URL.

You can also start individual services with the following commands:

```bash
pnpm dev:web
pnpm dev:data
pnpm dev:search
pnpm dev:native
pnpm dev:ios
```

The `dev:ios` command is required to build and connect to the native app for iOS, but once it's been built, if you just run `dev:native` it should automatically bundle and connect to the latest version.

## Testing

### Unit tests

Run the unit tests with:

```bash
pnpm test
```

And run the type checks and linters with:

```bash
pnpm check
```

## Database commands

These subcommands help manage data lifecycle during testing:

```bash
pnpm db:push     # push drizzle schema to the dev Postgres
pnpm db:mock     # populate Postgres with sample data
pnpm db:clear    # wipe the dev Postgres (drops the Docker volume)
pnpm data:clear  # wipe DuckLake + local turf blobs
pnpm clear       # wipe everything (Postgres + DuckLake + turf blobs)
```
