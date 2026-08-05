import { createInterface } from "node:readline/promises";
import meow from "meow";
import { db, eq, inArray } from "@turf-tools/db";
import { count } from "drizzle-orm";
import {
  campaigns,
  canvassEvents,
  organizations,
  scripts,
  segments,
  questions,
  responseOptions,
  turfs,
  walks,
  zoneGroups,
} from "@turf-tools/db/schema";
import { createLogger } from "./_logging";

const log = createLogger("reset-org");

const cli = meow(
  `
  Usage
    $ pnpm -F @turf-tools/scripts exec tsx prod-reset-org.ts [<slug>] [--force]

  Options
    --slug    Org slug to reset
    --force   Skip the typed-slug confirmation prompt

  Resets the org to a clean slate: deletes its content — campaigns, turfs, walks, canvass events,
  segments, zone groups, scripts, questions — while KEEPING the org
  itself, its memberships, and its dataset attachment/activation.
  Custom fields are dataset-scoped and untouched. For full removal use
  prod-remove-org.ts instead.
`,
  {
    importMeta: import.meta,
    flags: {
      slug: { type: "string" },
      force: { type: "boolean", default: false },
    },
  },
);

const slug = cli.flags.slug ?? cli.input[0];

if (!slug) {
  cli.showHelp(1);
}

const [org] = await db
  .select({ organizationId: organizations.organizationId, name: organizations.name })
  .from(organizations)
  .where(eq(organizations.slug, slug));

if (!org) {
  log.error(`no organization with slug "${slug}"`);
  process.exit(1);
}

const orgId = org.organizationId;

const campaignIdsQuery = db
  .select({ id: campaigns.campaignId })
  .from(campaigns)
  .where(eq(campaigns.organizationId, orgId));

const turfIdsQuery = db
  .select({ id: turfs.turfId })
  .from(turfs)
  .where(inArray(turfs.campaignId, campaignIdsQuery));

const questionIdsQuery = db
  .select({ id: questions.questionId })
  .from(questions)
  .where(eq(questions.organizationId, orgId));

const [
  campaignCount,
  turfCount,
  walkCount,
  canvassEventCount,
  segmentCount,
  zoneGroupCount,
  scriptCount,
  questionCount,
] = await Promise.all([
  db.select({ n: count() }).from(campaigns).where(eq(campaigns.organizationId, orgId)),
  db.select({ n: count() }).from(turfs).where(inArray(turfs.campaignId, campaignIdsQuery)),
  db.select({ n: count() }).from(walks).where(inArray(walks.turfId, turfIdsQuery)),
  db.select({ n: count() }).from(canvassEvents).where(inArray(canvassEvents.turfId, turfIdsQuery)),
  db.select({ n: count() }).from(segments).where(eq(segments.organizationId, orgId)),
  db.select({ n: count() }).from(zoneGroups).where(eq(zoneGroups.organizationId, orgId)),
  db.select({ n: count() }).from(scripts).where(eq(scripts.organizationId, orgId)),
  db.select({ n: count() }).from(questions).where(eq(questions.organizationId, orgId)),
]);

log.info(`will reset organization "${slug}" (${org.name}, id=${orgId}):`);
log.info(`- ${campaignCount[0].n} campaigns`);
log.info(`- ${turfCount[0].n} turfs (+ turf data/drafts, cascaded)`);
log.info(`- ${walkCount[0].n} walks`);
log.info(`- ${canvassEventCount[0].n} canvass events`);
log.info(`- ${segmentCount[0].n} segments`);
log.info(`- ${zoneGroupCount[0].n} zone groups (+ zones, cascaded)`);
log.info(`- ${scriptCount[0].n} scripts (+ script steps, cascaded)`);
log.info(`- ${questionCount[0].n} questions (+ response options)`);
log.info(`keeping: the org, memberships, dataset attachment + activation`);

if (!cli.flags.force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType the slug "${slug}" to confirm reset: `);
  rl.close();
  if (answer.trim() !== slug) {
    log.info("aborted (input did not match)");
    process.exit(0);
  }
}

await db.transaction(async (tx) => {
  // Leaves first, then parents — same graph as prod-remove-org.ts, plus
  // walks (no cascade from turfs) before turfs.
  await tx.delete(canvassEvents).where(inArray(canvassEvents.turfId, turfIdsQuery));
  await tx.delete(walks).where(inArray(walks.turfId, turfIdsQuery));
  await tx.delete(turfs).where(inArray(turfs.campaignId, campaignIdsQuery));
  await tx.delete(campaigns).where(eq(campaigns.organizationId, orgId));
  await tx.delete(scripts).where(eq(scripts.organizationId, orgId));
  await tx.delete(responseOptions).where(inArray(responseOptions.questionId, questionIdsQuery));
  await tx.delete(questions).where(eq(questions.organizationId, orgId));
  await tx.delete(segments).where(eq(segments.organizationId, orgId));
  await tx.delete(zoneGroups).where(eq(zoneGroups.organizationId, orgId));
});

log.success(`reset organization "${slug}"`);
process.exit(0);
