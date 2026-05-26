import { parseArgs } from "node:util";
import { and, db, eq, isNull } from "@field-tools/db";
import { memberships, organizations, users } from "@field-tools/db/schema";

// Canonical form used for user lookup + uniqueness, mirrors
// apps/web/src/lib/normalize-email.ts. Better Auth's magic-link flow
// queries `users.email` after running the typed input through this same
// transformation, so the inserted value must match exactly.
function normalizeEmail(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  const local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain !== "gmail.com") return `${local}@${domain}`;
  const plusIdx = local.indexOf("+");
  const beforePlus = plusIdx >= 0 ? local.slice(0, plusIdx) : local;
  const afterPlus = plusIdx >= 0 ? local.slice(plusIdx) : "";
  return `${beforePlus.replace(/\./g, "")}${afterPlus}@${domain}`;
}

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", default: "owner" },
  },
  strict: true,
});

const slug = values.slug;
const name = values.name;
const rawEmail = values.email;
const role = values.role!;

if (!slug || !name || !rawEmail) {
  console.error(
    "Usage: pnpm prod:add-user --slug <slug> --name <name> --email <email> [--role <role>]",
  );
  process.exit(1);
}

const email = normalizeEmail(rawEmail);

const [org] = await db
  .select({ organizationId: organizations.organizationId })
  .from(organizations)
  .where(eq(organizations.slug, slug));

if (!org) {
  console.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));

let userId: string;
if (existingUser) {
  userId = existingUser.id;
  console.log(`user already exists (${email}, id=${userId}); adding membership`);
} else {
  const [row] = await db
    .insert(users)
    .values({
      email,
      displayEmail: rawEmail,
      emailVerified: true,
      name,
    })
    .returning({ id: users.id });
  userId = row.id;
  console.log(`created user: ${name} <${rawEmail}> (id=${userId})`);
}

const [existingMembership] = await db
  .select({ membershipId: memberships.membershipId })
  .from(memberships)
  .where(
    and(
      eq(memberships.userId, userId),
      eq(memberships.organizationId, org.organizationId),
      isNull(memberships.archivedAt),
    ),
  );

if (existingMembership) {
  console.error(`user already has active membership in "${slug}"`);
  process.exit(1);
}

await db.insert(memberships).values({
  userId,
  organizationId: org.organizationId,
  role,
});

console.log(`added ${rawEmail} to ${slug} as ${role}`);
process.exit(0);
