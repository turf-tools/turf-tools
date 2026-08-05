# Turf Tools

Open source field organizing and canvassing platform.

The platform incldues three key components: (1) performant voter file data processing (including fully open-source geocoding) (2) a native canvassing application that runs on iOS and Android (3) a website for creating segments, scripts, and campaigns, and for cutting turf.

This project is in active development and currently undergoing early testing.

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
pnpm bootstrap
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
```

We leverage a two database design to get the best of both where needed:

- **Postgres** (via Drizzle/PGlite) — operational data: users, campaigns, segments, zone groups, turfs, canvass results
- **DuckLake** (via DuckDB) — analytical columnar data: voter files, persons, buildings, doors

## Voter file fixture

The mock data pipeline ingests a real NYS voter file. It isn't checked into the repo (it's large), so before the first `pnpm mock` you need to download it and place it in `apps/data/fixtures/`. The default fixture name and source URL are configurable via `apps/data/.env` (see `apps/data/.env.example` for the keys).

If `pnpm mock` runs without the fixture, the CLI prints the URL to download from and exits cleanly.

## Development

To run the voter file ingestion and build all necessary data inputs (assumes the fixture above is in place), run:

```bash
pnpm mock
```

Then start all services (web, native, data, search) by calling:

```bash
pnpm dev
```

This starts:

- `web` — TanStack Start admin UI and oPRC API (port 3000)
- `native` — Expo web preview of the mobile app (port 8081)
- `data` — FastAPI data service (including DuckDB/DuckLake) (port 8000)
- `search` — Quickwit search engine (port 7280)

The first time you run `dev`, the web server automatically pushes the Postgres schema to PGlite.

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
pnpm db:push     # push drizzle schema to PGlite
pnpm db:mock     # populate Postgres with sample data
pnpm data:mock   # ingest voter file → persons → geocoded → buildings/doors, plus boundary polygons
pnpm db:clear    # wipe PGlite data
pnpm data:clear  # wipe DuckLake + local turf blobs
pnpm clear       # wipe everything (PGlite + DuckLake + turf blobs)
```

`pnpm data:mock` does not build the Quickwit search index (the searcher isn't guaranteed to be running during setup). To make an existing dataset version searchable — powering the Lookup tab — start the searcher (`pnpm dev:search`) and backfill it:

```bash
cd apps/data && uv run seed-search --schema <schema>
```
