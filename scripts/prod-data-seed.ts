import { resolve } from "node:path";
import meow from "meow";
import { REPO_ROOT, createLogger, run } from "./_logging";

const log = createLogger("data-seed");

const cli = meow(
  `
  Usage
    $ pnpm prod:data:seed [<slug>]
    $ pnpm prod:data:seed --slug <slug>

  Options
    --slug   Org slug to seed DuckLake data for

  Notes
    Extra flags for seed-persons go after a -- separator. seed-boundaries
    always runs with just --org-slug.

  Examples
    $ pnpm prod:data:seed myorg
    $ pnpm prod:data:seed --slug myorg -- --fixture custom-voters.parquet
`,
  {
    importMeta: import.meta,
    flags: {
      slug: { type: "string" },
    },
  },
);

const slug = cli.flags.slug ?? cli.input[0];

if (!slug) {
  cli.showHelp(1);
}

// Anything after `--` (and the positional slug, if it was given that way)
// passes through to seed-persons.
const extras = cli.flags.slug ? cli.input : cli.input.slice(1);

const dataDir = resolve(REPO_ROOT, "apps/data");
const envSrc =
  "[ -f /etc/turf-tools-data.env ] && (set -a; . /etc/turf-tools-data.env; set +a); unset NODE_ENV";
const extrasStr = extras.length > 0 ? " " + extras.map((s) => JSON.stringify(s)).join(" ") : "";

log.task("seed-persons");
run(log, `${envSrc}; uv run seed-persons --org-slug ${JSON.stringify(slug)}${extrasStr}`, {
  cwd: dataDir,
});

log.task("seed-boundaries");
run(log, `${envSrc}; uv run seed-boundaries --org-slug ${JSON.stringify(slug)}`, { cwd: dataDir });

log.success(`seeded ducklake.${slug}`);
