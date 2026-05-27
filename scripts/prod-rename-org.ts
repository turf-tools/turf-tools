import meow from "meow";
import { db, eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";

const cli = meow(
  `
  Usage
    $ pnpm prod:rename-org [<slug> <new-name>]
    $ pnpm prod:rename-org --slug <slug> --name <new-name>

  Options
    --slug   Slug of the org to rename
    --name   New display name

  Examples
    $ pnpm prod:rename-org myorg 'My Renamed Org'
    $ pnpm prod:rename-org --slug myorg --name 'My Renamed Org'
`,
  {
    importMeta: import.meta,
    flags: {
      slug: { type: "string" },
      name: { type: "string" },
    },
  },
);

const slug = cli.flags.slug ?? cli.input[0];
const name = cli.flags.name ?? cli.input[1];

if (!slug || !name) {
  cli.showHelp(1);
}

const result = await db
  .update(organizations)
  .set({ name })
  .where(eq(organizations.slug, slug))
  .returning({ organizationId: organizations.organizationId });

if (result.length === 0) {
  console.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

console.log(`renamed organization with "${slug}" to "${name}"`);
process.exit(0);
