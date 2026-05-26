import { resolve } from "node:path";
import { REPO_ROOT, run, section } from "./_logging";

// Hand-roll the parse so we can split off --slug (which both subcommands
// need) from everything else (forwarded to seed-persons only — e.g.
// --fixture path/to/voters.parquet).
const argv = process.argv.slice(2);
let slug: string | undefined;
const extras: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--slug") {
    slug = argv[++i];
  } else if (a.startsWith("--slug=")) {
    slug = a.slice("--slug=".length);
  } else {
    extras.push(a);
  }
}

if (!slug) {
  console.error("Usage: pnpm prod:data:seed --slug <slug> [--fixture path/to/voters.parquet]");
  process.exit(1);
}

const dataDir = resolve(REPO_ROOT, "apps/data");
const envSrc =
  "[ -f /etc/field-tools-data.env ] && (set -a; . /etc/field-tools-data.env; set +a); unset NODE_ENV";
const extrasStr = extras.length > 0 ? " " + extras.map((s) => JSON.stringify(s)).join(" ") : "";

section("seed-persons");
run(`${envSrc}; uv run seed-persons --org-slug ${JSON.stringify(slug)}${extrasStr}`, {
  cwd: dataDir,
});

section("seed-boundaries");
run(`${envSrc}; uv run seed-boundaries --org-slug ${JSON.stringify(slug)}`, { cwd: dataDir });
