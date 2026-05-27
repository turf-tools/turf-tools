import meow from "meow";
import { db, eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";

const cli = meow(
  `
  Usage
    $ pnpm prod:create-org [<slug> <name>]
    $ pnpm prod:create-org --slug <slug> --name <name>

  Options
    --slug   Org slug (URL-safe identifier, used in URLs + DuckLake schema names)
    --name   Display name

  Examples
    $ pnpm prod:create-org myorg 'My Org'
    $ pnpm prod:create-org --slug myorg --name 'My Org'
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

const existing = await db
  .select({ organizationId: organizations.organizationId })
  .from(organizations)
  .where(eq(organizations.slug, slug));

if (existing.length > 0) {
  console.error(`organization with slug "${slug}" already exists`);
  process.exit(1);
}

const [row] = await db
  .insert(organizations)
  .values({ slug, name })
  .returning({ organizationId: organizations.organizationId });

console.log(`created organization: ${name} (slug=${slug}, id=${row.organizationId})`);
process.exit(0);
