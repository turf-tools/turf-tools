import meow from "meow";
import { and, db, eq, isNull } from "@field-tools/db";
import { memberships, organizations, users } from "@field-tools/db/schema";
import { createLogger } from "./_logging";

const log = createLogger("add-user");

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

const cli = meow(
  `
  Usage
    $ pnpm prod:add-user [<slug> <name> <email>] [--role <role>]
    $ pnpm prod:add-user --slug <slug> --name <name> --email <email> [--role <role>]

  Options
    --slug    Org slug to add the user to
    --name    User's display name
    --email   User's email
    --role    Role (default: owner)

  Examples
    $ pnpm prod:add-user myorg 'Jane Doe' jane@example.com
    $ pnpm prod:add-user myorg 'Jane Doe' jane@example.com --role member
`,
  {
    importMeta: import.meta,
    flags: {
      slug: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      role: { type: "string", default: "owner" },
    },
  },
);

const slug = cli.flags.slug ?? cli.input[0];
const name = cli.flags.name ?? cli.input[1];
const rawEmail = cli.flags.email ?? cli.input[2];
const role = cli.flags.role;

if (!slug || !name || !rawEmail) {
  cli.showHelp(1);
}

const email = normalizeEmail(rawEmail);

const [org] = await db
  .select({ organizationId: organizations.organizationId })
  .from(organizations)
  .where(eq(organizations.slug, slug));

if (!org) {
  log.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));

let userId: string;
if (existingUser) {
  userId = existingUser.id;
  log.info(`user already exists (${email}, id=${userId}); adding membership`);
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
  log.info(`created user: ${name} <${rawEmail}> (id=${userId})`);
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
  log.error(`user already has active membership in "${slug}"`);
  process.exit(1);
}

await db.insert(memberships).values({
  userId,
  organizationId: org.organizationId,
  role,
});

log.success(`added ${rawEmail} to ${slug} as ${role}`);
process.exit(0);
