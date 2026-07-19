import meow from "meow";
import { db, eq } from "@turf-tools/db";
import { organizations } from "@turf-tools/db/schema";
import { createLogger } from "./_logging";

const log = createLogger("rename-org-slug");

const cli = meow(
  `
  Usage
    $ pnpm prod:rename-org-slug [<slug> <new-slug>]
    $ pnpm prod:rename-org-slug --slug <slug> --new-slug <new-slug>

  Options
    --slug       Current slug
    --new-slug   New slug

  Examples
    $ pnpm prod:rename-org-slug myorg neworg
    $ pnpm prod:rename-org-slug --slug myorg --new-slug neworg
`,
  {
    importMeta: import.meta,
    flags: {
      slug: { type: "string" },
      newSlug: { type: "string" },
    },
  },
);

const slug = cli.flags.slug ?? cli.input[0];
const newSlug = cli.flags.newSlug ?? cli.input[1];

if (!slug || !newSlug) {
  cli.showHelp(1);
}

if (slug === newSlug) {
  log.error("--slug and --new-slug must differ");
  process.exit(1);
}

// Postgres first — the unique constraint catches collisions before we
// touch DuckLake. If the DuckLake rename fails afterward, the user is
// left with a Postgres slug that points at a missing schema; surface
// that loudly rather than silently rolling back.
const result = await db
  .update(organizations)
  .set({ slug: newSlug })
  .where(eq(organizations.slug, slug))
  .returning({ organizationId: organizations.organizationId });

if (result.length === 0) {
  log.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

// Dataset-version schemas are named from the dataset slug, independent of the
// org slug, so an org rename no longer touches DuckLake.
log.info(`updated organizations.slug: ${slug} → ${newSlug}`);

log.success(`renamed org slug: ${slug} → ${newSlug}`);
process.exit(0);
