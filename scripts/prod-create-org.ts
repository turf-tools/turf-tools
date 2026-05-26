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
  console.error("Usage: pnpm prod:create-org --slug <slug> --name <name>");
  process.exit(1);
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
