# Self-hosting Turf Tools

This guide describes deploying Turf Tools on a single machine with Docker Compose. The machine can be a cloud server or a local computer. Either way it needs a public hostname, because canvassers will connect to it over the internet. A [Kubernetes](#on-kubernetes) section at the end describes how the same pieces map could be deployed on a cluster.

For a worked example provisioning a cloud machine for Turf Tools using Pulumi, see [turf-tools-infra-example](https://github.com/turf-tools/turf-tools-infra-example).

## What runs

`compose.yaml` starts everything from published images:

- `caddy` — serves HTTPS for your domain, with certificates from Let's Encrypt
- `web` — the web app and the API the mobile app talks to
- `data` — imports and queries voter data
- `quickwit` — person lookup
- `postgres` — the main operational database plus catalogs for the voter data lakes and the search index
- `backup` and `backup-sync` — hourly database dumps, copied to your bucket

Postgres and the data server listen only on the machine's loopback interface. You can reach Postgres through an SSH tunnel for setup and other database interactions. Voter data and the search index are stored in your S3-compatible bucket.

## What you need

- **A Linux machine** with an x86-64 (amd64) processor and Docker (the published images are amd64 only).
- **A domain name** pointing at the machine, with ports 80 and 443 open to the internet (and 22 for SSH).
- **An S3-compatible bucket** and an access key for it, from any provider that accepts path-style requests.
- **An SMTP account** for sign-in emails (without one, sign-in links are printed to the web service's log).
- **On your own computer**: a checkout of this repository with [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/) (`pnpm install`), and SSH access to the machine for database setup.

For compute and memory resources, peak memory needs are mainly driven by voter imports running in the data service (several GBs for large cities and states). You can use `DUCKDB_MEMORY_LIMIT` to cap each of the data service's query engines, but the service as a whole uses a few GB more than that during an import. Several cores are useful for voter filtering performance, especially with multiple users. Local disk holds the street data downloaded per state (a few GB each) plus the database and backups. The best performance we've seen is on a bare metal box with multiple cores and lots of RAM, but we've also run it fine on standard Digital Ocean droplets.

The published web image has the project's [MapTiler](https://www.maptiler.com/) key built in, which all the maps use. To use your own key, build the web image yourself and push it to a registry your machine can pull from, then point `WEB_IMAGE` at it:

```bash
VITE_MAPTILER_KEY=<your key> REGISTRY=ghcr.io/<you> pnpm images:push --only web
```

## Deployment

### 1. Prepare the machine

Install Docker and create the configuration directory:

```bash
curl -fsSL https://get.docker.com | sh
sudo install -d -m 0750 /etc/turf-tools
```

### 2. Write the configuration

On your computer, copy `deploy/.env.example` to a new file and fill it in. Every setting is explained there. At minimum set `DOMAIN`, `BETTER_AUTH_URL`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, and the `STORAGE_*` settings for your bucket.

### 3. Copy the files to the machine

The machine needs `compose.yaml`, `Caddyfile`, `postgres-init.sql`, and `backup.sh` from `deploy/`, plus your configuration as `.env`, all in `/etc/turf-tools`:

```bash
scp deploy/compose.yaml deploy/Caddyfile deploy/postgres-init.sql deploy/backup.sh my.env user@turf.example.org:/tmp/
ssh user@turf.example.org
sudo install -m 0644 -o root -g root /tmp/compose.yaml /tmp/Caddyfile /tmp/postgres-init.sql /tmp/backup.sh /etc/turf-tools/
sudo install -m 0640 -o root -g root /tmp/my.env /etc/turf-tools/.env
rm /tmp/compose.yaml /tmp/Caddyfile /tmp/postgres-init.sql /tmp/backup.sh /tmp/my.env
```

Keep `.env` private (`0640`) but the other files world-readable (`0644`). Postgres runs as a non-root user inside its container and silently skips an init script it can't read, which leaves the extra databases uncreated.

### 4. Start it

```bash
cd /etc/turf-tools
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

Caddy requests a certificate on first start. After a minute or so `https://<your domain>` should load the sign-in page.

### 5. Set up the database

From your checkout, open a tunnel to the machine's Postgres in one terminal:

```bash
ssh -N -L 15432:127.0.0.1:5432 user@turf.example.org
```

In another, create the schema, load the reference data it needs, and create your organization and first user:

```bash
export DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:15432/turf_tools
pnpm db push
pnpm db:seed
pnpm -F @turf-tools/scripts exec tsx prod-create-org.ts <slug> '<Organization name>'
pnpm -F @turf-tools/scripts exec tsx prod-add-user.ts <slug> '<Your name>' <email>
```

`db:seed` isn't optional: it inserts lookup rows the app's jobs depend on. The user is an owner. Add more users later from the web app.

### 6. Sign in and import voter data

Sign in at `https://<your domain>` with that email. Without SMTP, find the link with `sudo docker compose logs web`.

Import a voter file from the Data page: pick the file's type and give an `http://` or `https://` link the machine can download for each file. The supported formats are described in [the importers README](../apps/data/src/importers/README.md). The first import in a state also downloads that state's street data from the U.S. Census Bureau and OpenStreetMap, which takes several minutes. Later imports in the same state reuse it and are much faster.

Canvassers use the Turf Tools app from the App Store or Google Play, which can point to any deployment. A turf's QR code carries your deployment's hostname directly. A shared turf link goes through `to.turf.tools`, a small service the Turf Tools project runs, which opens the app and passes your hostname along.

## Maintence

For general inspection run these in `/etc/turf-tools` on the machine:

```bash
sudo docker compose ps                    # what's running
sudo docker compose logs -f --tail 100 data   # follow a service's log
sudo docker compose restart web           # restart a service
```

### Updating

Pin a release in `.env` by setting `WEB_IMAGE` and `DATA_IMAGE` to the same `sha-<commit>` tag, then:

```bash
sudo docker compose pull
sudo docker compose up -d --remove-orphans
```

When a release changes the database schema, run `pnpm db push` (step 5, from a checkout at that release) before starting the new images. To see what's running:

```bash
for s in web data; do sudo docker inspect --format '{{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' $(sudo docker compose ps -q $s); done
```

When `compose.yaml` or the other files in `deploy/` change, copy them again as in step 3.

### Backups

The `backup` service dumps the app database, both data lake catalogs, and the search index's metastore every hour into `/var/lib/turf-tools/backups`, keeping the last 24 hourly and 31 daily dumps. `backup-sync` copies that directory to `backups/` in your bucket every five minutes. Voter data and the search index already live in the bucket. Restore with `pg_restore` into the `postgres` container.

## On Kubernetes

Nothing in the app assumes Docker Compose so the same services can easily run on a cluster (and we have deployed it that way in production). As a high-level sketch of how to do it:

- **Postgres** through an operator such as [CloudNativePG](https://cloudnative-pg.io/), creating the four databases that `postgres-init.sql` creates (`turf_tools`, `turf_tools_ducklake`, `turf_tools_ducklake_geo`, `quickwit`). The operator's own backups replace the `backup` services.
- **`web`, `data`, and `quickwit`** as single-replica Deployments, with the environment that `compose.yaml` sets for each and your settings from Secrets. `data` and `quickwit` each need a persistent volume for their search cache (`/qwdata`), and `data` aneeds nother for the downloaded street data (`/app/osm_cache` and `/app/tiger_cache`); use the `Recreate` update strategy for both, since each volume has one writer. The two coordinate through the Postgres metastore and the bucket, so they don't share a volume.
- **An Ingress** with TLS (for example, cert-manager) in front of `web`. Allow request bodies up to 300 MB for custom-field uploads, and don't reuse upstream connections longer than the web server's 5-second keep-alive.
- **Sizing**: give `data` room for imports (see above) and set `DUCKDB_MEMORY_LIMIT` well below its memory limit, leaving a few GB for the rest of the service. Postgres shares the node's memory, so an import that crowds the node can slow Postgres enough to fail its health checks.

Schema setup works the same way as step 5, with `kubectl port-forward` to the Postgres service in place of the SSH tunnel.
