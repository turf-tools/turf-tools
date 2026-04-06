# Turf

Open source field organizing and canvassing platform. Very much a work in progress.

## Prerequisites

You'll need to have these installed to run the development environment.

- [Node.js](https://nodejs.org/) >= 22.12
- [pnpm](https://pnpm.io/) enabled via `corepack enable`
- [uv](https://docs.astral.sh/uv/) `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [Quickwit](https://quickwit.io/) `curl -L https://install.quickwit.io | sh` (move binary to `/usr/local/bin/`)
- [Xcode](https://developer.apple.com/xcode/) (optional, for iOS simulator)

## Setup

Once the above are installed, run this to install both Node and Python dependencies.

```bash
pnpm setup
```

## Architecture

The overall structure is as follows:

```
apps/
  web/       TanStack Start — admin UI, oRPC API, system orchestrator
  native/    Expo/React Native — mobile canvassing app
  data/      FastAPI + DuckDB — voter file processing, geocoding, search indexing

packages/
  db/        Drizzle schema + PGlite/Postgres client
  utils/     Shared utilities (not yet used)
```

We leverage a two database design to get the best of both where needed:

- **Postgres** (via Drizzle/PGlite) — operational data: users, campaigns, universes, turfs, canvass results
- **DuckLake** (via DuckDB) — analytical columnar data: voter files, buildings, doors, universe members

## Development

Start all services (web, native, data, search) by calling:

```bash
pnpm dev
```

This starts:

- `web` — TanStack Start admin UI and oPRC API (port 3000)
- `native` — Expo web preview of the mobile app (port 8081)
- `data` — FastAPI data service (including DuckDB/DuckLake) (port 8000)
- `search` — Quickwit search engine (port 7280)

The first time you run `dev`, the web server automatically pushes the Postgres schema to PGlite and seeds a default organization and user. This will also happen anytime you run `pnpm clear` and then run `pnpm dev` again.

You can also start individual services with the following commands:

```bash
pnpm dev:web
pnpm dev:data
pnpm dev:search
pnpm dev:native
pnpm dev:ios
```

The `dev:ios` command is required to build and connect to the native app for iOS, but once it's been built, if you just run `dev:native` it should automatically bundle and connect to the latest version.

## Importing data

The following steps demo basic functionality for importing data. With `pnpm dev` running:

```bash
# Import a voter file fixture
curl -X POST http://localhost:8000/voter-file/import \
  -H "Content-Type: application/json" \
  -d '{"file_path": "fixtures/nys-voters-2026-03-08-ad-65-ed-39.parquet"}'

# Geocode building addresses
curl -X POST http://localhost:8000/buildings/geocode

# Index into Quickwit for search
curl -X POST http://localhost:8000/people/index

# Search
curl "http://localhost:8000/people/search?q=last_name:SMITH"
```

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

### Integration test

The integration test runs the full pipeline (import, geocode, index, search) against running services. Run these three commands to wipe all local data, start all services, and then run a pipeline test.

```bash
pnpm clear
pnpm dev
pnpm test:integration
```

## Database commands

These subcommands help manage data lifecycle during testing:

```bash
pnpm db:setup    # push schema + seed (runs automatically with dev:web)
pnpm db:push     # push drizzle schema to PGlite
pnpm db:seed     # seed default org + user
pnpm db:clear    # wipe PGlite data
pnpm data:clear  # wipe DuckLake + Quickwit data
pnpm clear       # wipe everything (PGlite + DuckLake + Quickwit)
```
