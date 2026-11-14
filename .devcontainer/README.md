# Dev container (optional)

An optional, self-contained environment for the web app, the mobile app, and
the data pipeline. **Development on the host, as described in the top-level
README, stays fully supported and unchanged.** This container is a second path
for people who would rather not install the whole toolchain locally.

Reasons to use it:

- you do not want to install Node, Python, `uv`, `osmium-tool`, and Quickwit on
  your machine
- you are building for Android, where the SDK and JDK are the painful part
- you want the same environment a CI job would have

Reasons to stay on the host:

- iOS work, since Xcode only runs on macOS
- you already have the toolchain and prefer the shortest path

The two can be mixed. A common setup is Metro and the services in the container
with the iOS dev client built on a Mac, described below. What you cannot do is
run both stacks at once: they publish the same ports.

Included:

- Node 22 and the pnpm version pinned in `package.json` (via corepack)
- Python 3.13 and `uv`, for `apps/data`
- `osmium-tool` (OSM geocoding), Quickwit 0.9.3 (search), Graphviz (DAG
  visualizations), `psql`, `jq`
- JDK 17 and the Android SDK (platform 36, build-tools 36)
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

## Dependency trees stay in the container

`node_modules` (at the workspace root and in `apps/web`, `apps/native`,
`packages/db`, `scripts`) and `apps/data/.venv` are named volumes. The host's
trees are not mounted here at all, so a host `pnpm install` and the container's
install can never fight over the same files. Nothing about host development
changes.

If you add a workspace package that gets its own `node_modules`, add a volume
for it in `docker-compose.yml` and a `chown` line in `post-create.sh`; the
volumes start root-owned and are handed to the `node` user on create.

To wipe the container's dependency trees and database, stop the stack and drop
its volumes:

```bash
docker compose -f docker-compose.dev.yml -f .devcontainer/docker-compose.yml down -v
```

## Run

```bash
pnpm dev          # db, web, native, data, search
pnpm dev:web      # or one service at a time
pnpm dev:data
pnpm dev:search
pnpm dev:native
pnpm test
pnpm check
```

Ports 3000 (web), 7280 (search), 8000 (data), and 8081 (native web preview /
Metro) are published on the host's loopback.

## Android

The APK builds in the container. The emulator has to run on the host, because
it needs `/dev/kvm`.

```bash
pnpm --filter native exec expo prebuild --platform android --no-install
cd apps/native/android && ./gradlew assembleDebug
```

The first build downloads the NDK and CMake, so it takes around 12 minutes. The
APK lands at `apps/native/android/app/build/outputs/apk/debug/app-debug.apk`.

From the host, with an emulator running:

```bash
adb install -r apps/native/android/app/build/outputs/apk/debug/app-debug.apk
```

A dev build loads its bundle from Metro, which from inside the emulator is
`http://10.0.2.2:8081`.

## iOS

Xcode runs only on macOS, so the native build happens on the host while the
container keeps doing the JavaScript work.

1. On the Mac, in the same checkout: `pnpm --filter native run ios`. That
   prebuilds, installs pods, and builds the dev client into the simulator,
   using the host's own `node_modules`.
2. Metro runs in the container and is published on the host's loopback, so the
   simulator loads the bundle from `http://localhost:8081` with no extra
   configuration.
3. Source edits are shared through the bind mount, so fast refresh works
   whichever side you edit on.

Without a Mac, `npx eas build --profile development --platform ios` builds in
the cloud; install the artifact on a device and point it at Metro.

The generated `apps/native/ios` directory lives on the host and is gitignored.

## Database wiring

`devcontainer.json` layers this directory's compose file on top of the repo's
`../docker-compose.dev.yml`, so the database definition keeps one source of
truth. The app service sets:

```
DB_HOST=postgres
DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
QW_METASTORE_URI=postgres://postgres:postgres@postgres:5432/quickwit
```

and the Postgres service drops its host port publish with `ports: !reset []`,
so an existing database on 5432 is left alone.

`scripts/ensure-postgres.mjs` probes `DB_HOST` first. Inside the container the
database is already up, so it skips starting another one; on a host with no
`DB_HOST`, it still starts the compose database and fails loudly if something
else owns the port.

Requires Compose with `!reset` support (2.24+, or a recent `podman-compose`).

## Authentication

`AUTH_DISABLED=1` is not set for you. Uncomment it in `apps/web/.env` if you
want to skip the magic-link flow; otherwise the login link is written to the
web server's console.

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
- `pnpm db:clear` is host-only; inside the container, use the `down -v`
  command above.
