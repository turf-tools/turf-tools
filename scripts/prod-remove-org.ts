import { createInterface } from "node:readline/promises";
import meow from "meow";
import { db, eq, inArray } from "@field-tools/db";
import { count } from "drizzle-orm";
import {
  campaigns,
  canvassEvents,
  datasetOrganizations,
  memberships,
  organizations,
  scripts,
  segments,
  questions,
  responseOptions,
  turfs,
  zoneGroups,
} from "@field-tools/db/schema";
import { createLogger } from "./_logging";

const log = createLogger("remove-org");

const cli = meow(
  `
  Usage
    $ pnpm prod:remove-org [<slug>] [--force]
    $ pnpm prod:remove-org --slug <slug> [--force]

  Options
    --slug    Org slug to remove
    --force   Skip the typed-slug confirmation prompt

  Examples
    $ pnpm prod:remove-org myorg
    $ pnpm prod:remove-org --slug myorg --force

  Destroys: Postgres org row + every row that references it (memberships,
  campaigns, turfs, canvass events, segments, zone groups, scripts,
  questions), plus the ducklake.<slug> schema and all of its tables.
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
const force = cli.flags.force;

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

// Sub-queries for transitive lookups (turfs / canvass_events / response options)
// reference the parent IDs that live in org-scoped tables, so we resolve once
// and reuse below.
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

async function counts() {
  const [
    membershipCount,
    campaignCount,
    turfCount,
    canvassEventCount,
    segmentCount,
    zoneGroupCount,
    scriptCount,
    questionCount,
  ] = await Promise.all([
    db.select({ n: count() }).from(memberships).where(eq(memberships.organizationId, orgId)),
    db.select({ n: count() }).from(campaigns).where(eq(campaigns.organizationId, orgId)),
    db.select({ n: count() }).from(turfs).where(inArray(turfs.campaignId, campaignIdsQuery)),
    db
      .select({ n: count() })
      .from(canvassEvents)
      .where(inArray(canvassEvents.turfId, turfIdsQuery)),
    db.select({ n: count() }).from(segments).where(eq(segments.organizationId, orgId)),
    db.select({ n: count() }).from(zoneGroups).where(eq(zoneGroups.organizationId, orgId)),
    db.select({ n: count() }).from(scripts).where(eq(scripts.organizationId, orgId)),
    db.select({ n: count() }).from(questions).where(eq(questions.organizationId, orgId)),
  ]);
  return {
    memberships: membershipCount[0].n,
    campaigns: campaignCount[0].n,
    turfs: turfCount[0].n,
    canvassEvents: canvassEventCount[0].n,
    segments: segmentCount[0].n,
    zoneGroups: zoneGroupCount[0].n,
    scripts: scriptCount[0].n,
    questions: questionCount[0].n,
  };
}

const totals = await counts();

log.info(`will delete organization "${slug}" (${org.name}, id=${orgId}) and:`);
log.info(`- ${totals.memberships} memberships`);
log.info(`- ${totals.campaigns} campaigns`);
log.info(`- ${totals.turfs} turfs`);
log.info(`- ${totals.canvassEvents} canvass events`);
log.info(`- ${totals.segments} segments`);
log.info(`- ${totals.zoneGroups} zone groups (+ zones, cascaded)`);
log.info(`- ${totals.scripts} scripts (+ script steps, cascaded)`);
log.info(`- ${totals.questions} questions (+ response options)`);
log.info(`- the ducklake.${slug} schema and all tables in it`);

if (!force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType the slug "${slug}" to confirm deletion: `);
  rl.close();
  if (answer.trim() !== slug) {
    log.info("aborted (input did not match)");
    process.exit(0);
  }
}

await db.transaction(async (tx) => {
  // Order matters: leaves first, then parents. canvass_events and turfs go
  // before campaigns (canvass_events → turfs → campaigns); campaigns before
  // segments/zone-groups/scripts (campaigns FK those); response options
  // before questions. Tables with onDelete: "cascade" (script_steps,
  // zones, turf_data, turf_drafts) come down with their parents.
  await tx.delete(canvassEvents).where(inArray(canvassEvents.turfId, turfIdsQuery));
  await tx.delete(turfs).where(inArray(turfs.campaignId, campaignIdsQuery));
  await tx.delete(campaigns).where(eq(campaigns.organizationId, orgId));
  await tx.delete(scripts).where(eq(scripts.organizationId, orgId));
  await tx.delete(responseOptions).where(inArray(responseOptions.questionId, questionIdsQuery));
  await tx.delete(questions).where(eq(questions.organizationId, orgId));
  await tx.delete(segments).where(eq(segments.organizationId, orgId));
  await tx.delete(zoneGroups).where(eq(zoneGroups.organizationId, orgId));
  // Drop the org's dataset access grants. The datasets themselves are
  // deployment-level (possibly shared with other orgs) and their DuckLake
  // schemas are dataset-derived, so removing an org never drops dataset data.
  await tx.delete(datasetOrganizations).where(eq(datasetOrganizations.organizationId, orgId));
  await tx.delete(memberships).where(eq(memberships.organizationId, orgId));
  await tx.delete(organizations).where(eq(organizations.organizationId, orgId));
});

log.success(`removed organization "${slug}"`);
process.exit(0);
