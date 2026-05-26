import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { db, eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    "new-slug": { type: "string" },
  },
  strict: true,
});

const slug = values.slug;
const newSlug = values["new-slug"];

if (!slug || !newSlug) {
  console.error("Usage: pnpm prod:rename-org-slug --slug <old> --new-slug <new>");
  process.exit(1);
}

if (slug === newSlug) {
  console.error("--slug and --new-slug must differ");
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
  console.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

console.log(`updated organizations.slug: ${slug} → ${newSlug}`);

const py = spawnSync("uv", ["run", "rename-org-schema", "--from", slug, "--to", newSlug], {
  cwd: "apps/data",
  stdio: "inherit",
});

if (py.status !== 0) {
  console.error(
    `\nWARNING: DuckLake rename failed (exit ${py.status}). ` +
      `Postgres now points at slug "${newSlug}" but the DuckLake schema is still "${slug}". ` +
      `Re-run \`uv run rename-org-schema --from ${slug} --to ${newSlug}\` from apps/data once fixed.`,
  );
  process.exit(py.status ?? 1);
}

process.exit(0);
