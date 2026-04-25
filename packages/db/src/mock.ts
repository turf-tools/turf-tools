import { eq } from "drizzle-orm";
import { db } from "./index";
import { campaigns } from "./schema/campaigns";
import { organizations } from "./schema/organizations";
import { scripts, scriptQuestions } from "./schema/scripts";
import { segments } from "./schema/segments";
import { surveyQuestions, surveyResponseOptions } from "./schema/surveys";
import { turfs } from "./schema/turfs";
import { users } from "./schema/users";
import { zoneGroups } from "./schema/zone-groups";
import { zones } from "./schema/zones";

// Deterministic ids so this script is idempotent and other services (e.g. the
// data service's mock script) can reference them without a lookup. Shaped as
// valid UUID v4 (version nibble = 4, variant nibble = 8) so Zod's strict
// `.uuid()` validator accepts them.
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";
const SURVEY_QUESTION_ID = "00000000-0000-4000-8000-000000000003";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000004";
const SEGMENT_ID = "00000000-0000-4000-8000-000000000005";
const TURF_ID = "00000000-0000-4000-8000-000000000006";

// Extra campaigns + segments for exercising the admin UI. These are not
// referenced by the native app (which pins to the four ids above); they
// exist only to give the campaigns and segments tables more than one row
// and to cover the case where a segment belongs to a campaign other than
// the default.
const PETITIONING_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000007";
const PERSUASION_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000008";
const SWING_SEGMENT_ID = "00000000-0000-4000-8000-000000000009";
const BASE_SEGMENT_ID = "00000000-0000-4000-8000-00000000000a";
const TURNOUT_SEGMENT_ID = "00000000-0000-4000-8000-00000000000b";
const NYC_ZONE_GROUP_ID = "00000000-0000-4000-8000-00000000000f";
const MANHATTAN_ZONE_ID = "00000000-0000-4000-8000-00000000000c";
const BROOKLYN_ZONE_ID = "00000000-0000-4000-8000-00000000000d";
const QUEENS_ZONE_ID = "00000000-0000-4000-8000-00000000000e";

const DATA_SERVICE_URL = process.env.DATA_SERVICE_PUBLIC_URL ?? "http://localhost:8000";

const DEFAULT_VOTER_FILE_ID = "nys_boe";
const DEFAULT_VOTER_FILE_VERSION = 1;

const SURVEY_RESPONSE_OPTIONS: Array<{ id: string; text: string }> = [
  { id: "00000000-0000-4000-8000-000000000030", text: "Yes" },
  { id: "00000000-0000-4000-8000-000000000031", text: "Leaning yes" },
  { id: "00000000-0000-4000-8000-000000000032", text: "Undecided" },
  { id: "00000000-0000-4000-8000-000000000033", text: "Leaning no" },
  { id: "00000000-0000-4000-8000-000000000034", text: "No" },
];

async function mock() {
  const existingOrg = await db
    .select()
    .from(organizations)
    .where(eq(organizations.organizationId, ORG_ID));
  if (existingOrg.length === 0) {
    await db.insert(organizations).values({
      organizationId: ORG_ID,
      slug: "default",
      name: "Default Organization",
    });
    console.log("Created organization");
  }

  const existingUser = await db.select().from(users).where(eq(users.userId, USER_ID));
  if (existingUser.length === 0) {
    await db.insert(users).values({
      userId: USER_ID,
      organizationId: ORG_ID,
      email: "admin@field.tools",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
    });
    console.log("Created user");
  }

  const existingCampaign = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.campaignId, CAMPAIGN_ID));
  if (existingCampaign.length === 0) {
    await db.insert(campaigns).values({
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Default Campaign",
      createdBy: USER_ID,
    });
    console.log("Created campaign");
  }

  const existingPetitioning = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.campaignId, PETITIONING_CAMPAIGN_ID));
  if (existingPetitioning.length === 0) {
    await db.insert(campaigns).values({
      campaignId: PETITIONING_CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Petitioning",
      createdBy: USER_ID,
    });
    console.log("Created campaign");
  }

  const existingPersuasion = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.campaignId, PERSUASION_CAMPAIGN_ID));
  if (existingPersuasion.length === 0) {
    await db.insert(campaigns).values({
      campaignId: PERSUASION_CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Persuasion",
      createdBy: USER_ID,
    });
    console.log("Created campaign");
  }

  const existingQuestion = await db
    .select()
    .from(surveyQuestions)
    .where(eq(surveyQuestions.surveyQuestionId, SURVEY_QUESTION_ID));
  if (existingQuestion.length === 0) {
    await db.insert(surveyQuestions).values({
      surveyQuestionId: SURVEY_QUESTION_ID,
      organizationId: ORG_ID,
      text: "Are you planning to vote for our candidate?",
      createdBy: USER_ID,
    });
    await db.insert(surveyResponseOptions).values(
      SURVEY_RESPONSE_OPTIONS.map((opt, order) => ({
        surveyResponseOptionId: opt.id,
        surveyQuestionId: SURVEY_QUESTION_ID,
        text: opt.text,
        order,
        createdBy: USER_ID,
      })),
    );
    console.log("Created survey question and response options");
  }

  const existingScript = await db.select().from(scripts).where(eq(scripts.scriptId, SCRIPT_ID));
  if (existingScript.length === 0) {
    await db.insert(scripts).values({
      scriptId: SCRIPT_ID,
      campaignId: CAMPAIGN_ID,
      name: "Default Script",
      createdBy: USER_ID,
    });
    await db.insert(scriptQuestions).values({
      scriptId: SCRIPT_ID,
      surveyQuestionId: SURVEY_QUESTION_ID,
      order: 0,
    });
    console.log("Created script");
  }

  const existingSegment = await db
    .select()
    .from(segments)
    .where(eq(segments.segmentId, SEGMENT_ID));
  if (existingSegment.length === 0) {
    await db.insert(segments).values({
      segmentId: SEGMENT_ID,
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Default Segment",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      createdBy: USER_ID,
    });
    console.log("Created segment");
  }

  const existingSwing = await db
    .select()
    .from(segments)
    .where(eq(segments.segmentId, SWING_SEGMENT_ID));
  if (existingSwing.length === 0) {
    await db.insert(segments).values({
      segmentId: SWING_SEGMENT_ID,
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Base",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 1247,
      personCount: 2980,
      createdBy: USER_ID,
    });
    console.log("Created segment");
  }

  const existingBase = await db
    .select()
    .from(segments)
    .where(eq(segments.segmentId, BASE_SEGMENT_ID));
  if (existingBase.length === 0) {
    await db.insert(segments).values({
      segmentId: BASE_SEGMENT_ID,
      campaignId: PETITIONING_CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Swing",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 856,
      personCount: 1920,
      createdBy: USER_ID,
    });
    console.log("Created segment");
  }

  const existingTurnout = await db
    .select()
    .from(segments)
    .where(eq(segments.segmentId, TURNOUT_SEGMENT_ID));
  if (existingTurnout.length === 0) {
    await db.insert(segments).values({
      segmentId: TURNOUT_SEGMENT_ID,
      campaignId: PERSUASION_CAMPAIGN_ID,
      organizationId: ORG_ID,
      name: "Growth",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 3456,
      personCount: 7890,
      createdBy: USER_ID,
    });
    console.log("Created segment");
  }

  const existingZoneGroup = await db
    .select()
    .from(zoneGroups)
    .where(eq(zoneGroups.zoneGroupId, NYC_ZONE_GROUP_ID));
  if (existingZoneGroup.length === 0) {
    await db.insert(zoneGroups).values({
      zoneGroupId: NYC_ZONE_GROUP_ID,
      organizationId: ORG_ID,
      name: "NYC EDs",
      keyGroup: "nyc_eds",
      createdBy: USER_ID,
    });
    console.log("Created zone group NYC EDs");
  }

  const zoneSeeds: Array<{ id: string; name: string }> = [
    { id: MANHATTAN_ZONE_ID, name: "Manhattan" },
    { id: BROOKLYN_ZONE_ID, name: "Brooklyn" },
    { id: QUEENS_ZONE_ID, name: "Queens" },
  ];
  for (const z of zoneSeeds) {
    const existing = await db.select().from(zones).where(eq(zones.zoneId, z.id));
    if (existing.length === 0) {
      await db.insert(zones).values({
        zoneId: z.id,
        zoneGroupId: NYC_ZONE_GROUP_ID,
        name: z.name,
        keys: [],
        createdBy: USER_ID,
      });
      console.log(`Created zone ${z.name}`);
    }
  }

  const existingTurf = await db.select().from(turfs).where(eq(turfs.turfId, TURF_ID));
  if (existingTurf.length === 0) {
    await db.insert(turfs).values({
      turfId: TURF_ID,
      campaignId: CAMPAIGN_ID,
      segmentId: SEGMENT_ID,
      scriptId: SCRIPT_ID,
      name: "Default Turf",
      turfCode: "121121",
      dataUrl: `${DATA_SERVICE_URL}/turfs/${TURF_ID}/data`,
      assignedTo: USER_ID,
      createdBy: USER_ID,
    });
    console.log("Created default turf");
  }

  console.log("Mock data in database.");
  process.exit(0);
}

void mock();
