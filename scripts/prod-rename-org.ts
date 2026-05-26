import { parseArgs } from "node:util";
import { db, eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
  },
  strict: true,
});

const slug = values.slug;
const name = values.name;

if (!slug || !name) {
  console.error("Usage: pnpm prod:rename-org --slug <slug> --name <new-name>");
  process.exit(1);
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

console.log(`renamed organization "${slug}" → "${name}"`);
process.exit(0);
