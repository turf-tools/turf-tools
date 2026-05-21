import { eq } from "drizzle-orm";
import { db } from "./index";
import { SEEDED_ADMIN_USER_ID, SEEDED_ORG_ID } from "./ids";
import { seedReferenceData } from "./seed";
import { campaigns } from "./schema/campaigns";
import { memberships } from "./schema/memberships";
import { organizations } from "./schema/organizations";
import { scripts, scriptQuestions } from "./schema/scripts";
import { segments } from "./schema/segments";
import { surveyQuestions, surveyResponseOptions } from "./schema/surveys";
import { users } from "./schema/auth/users";
import { zoneGroups } from "./schema/zone-groups";
import { zones } from "./schema/zones";

// Deterministic ids so this script is idempotent and other services (e.g. the
// data service's mock script) can reference them without a lookup. Shaped as
// valid UUID v4 (version nibble = 4, variant nibble = 8) so Zod's strict
// `.uuid()` validator accepts them.
const ORG_ID = SEEDED_ORG_ID;
const USER_ID = SEEDED_ADMIN_USER_ID;
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";
const SURVEY_QUESTION_ID = "00000000-0000-4000-8000-000000000003";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000004";
const SEGMENT_ID = "00000000-0000-4000-8000-000000000005";

// Extra campaigns + segments for exercising the admin UI.
const PETITIONING_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000007";
const PERSUASION_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000008";
const SWING_SEGMENT_ID = "00000000-0000-4000-8000-000000000009";
const BASE_SEGMENT_ID = "00000000-0000-4000-8000-00000000000a";
const TURNOUT_SEGMENT_ID = "00000000-0000-4000-8000-00000000000b";
const NYC_EDS_GROUP_ID = "00000000-0000-4000-8000-00000000000f";
const NYC_ZIPS_GROUP_ID = "00000000-0000-4000-8000-000000000010";
const MANHATTAN_ZONE_ID = "00000000-0000-4000-8000-00000000000c";
const BROOKLYN_ZONE_ID = "00000000-0000-4000-8000-00000000000d";
const QUEENS_ZONE_ID = "00000000-0000-4000-8000-00000000000e";

// Second org for exercising multi-tenancy. The admin user is added with
// role "admin" (not "owner") so the per-org permission check is visible
// in the UI — Users tab disappears when switched to this org.
const SECOND_ORG_ID = "00000000-0000-4000-8000-000000000020";
const SECOND_SURVEY_QUESTION_ID = "00000000-0000-4000-8000-000000000021";
const SECOND_SCRIPT_ID = "00000000-0000-4000-8000-000000000022";
const SECOND_SEGMENT_ID = "00000000-0000-4000-8000-000000000023";
const SECOND_ZONE_GROUP_ID = "00000000-0000-4000-8000-000000000024";
const SECOND_ZONE_ID = "00000000-0000-4000-8000-000000000025";
const SECOND_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000026";
const SECOND_RESPONSE_OPTION_IDS = [
  "00000000-0000-4000-8000-000000000040",
  "00000000-0000-4000-8000-000000000041",
  "00000000-0000-4000-8000-000000000042",
];

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
  // Insert order matters: campaigns now FK to scripts/segments/zone groups,
  // so those must exist first.

  await seedReferenceData();

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

  const existingUser = await db.select().from(users).where(eq(users.id, USER_ID));
  if (existingUser.length === 0) {
    await db.insert(users).values({
      id: USER_ID,
      email: process.env.SEED_USER_EMAIL ?? "admin@field.tools",
      emailVerified: true,
      name: process.env.SEED_USER_NAME ?? "Admin User",
    });
    await db.insert(memberships).values({
      userId: USER_ID,
      organizationId: ORG_ID,
      role: "owner",
    });
    console.log("Created user and owner membership");
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
      organizationId: ORG_ID,
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

  const segmentSeeds: Array<{
    id: string;
    name: string;
    doorCount?: number;
    personCount?: number;
  }> = [
    { id: SEGMENT_ID, name: "Default Segment" },
    { id: SWING_SEGMENT_ID, name: "Base", doorCount: 1247, personCount: 2980 },
    { id: BASE_SEGMENT_ID, name: "Swing", doorCount: 856, personCount: 1920 },
    { id: TURNOUT_SEGMENT_ID, name: "Growth", doorCount: 3456, personCount: 7890 },
  ];
  for (const s of segmentSeeds) {
    const existing = await db.select().from(segments).where(eq(segments.segmentId, s.id));
    if (existing.length === 0) {
      await db.insert(segments).values({
        segmentId: s.id,
        organizationId: ORG_ID,
        name: s.name,
        criteria: { steps: [] },
        voterFileId: DEFAULT_VOTER_FILE_ID,
        voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
        doorCount: s.doorCount,
        personCount: s.personCount,
        createdBy: USER_ID,
      });
      console.log(`Created segment ${s.name}`);
    }
  }

  const zoneGroupSeeds: Array<{ id: string; name: string; keyGroup: string }> = [
    { id: NYC_EDS_GROUP_ID, name: "NYC EDs", keyGroup: "nyc_eds" },
    { id: NYC_ZIPS_GROUP_ID, name: "NYC ZIPs", keyGroup: "nyc_zips" },
  ];
  for (const g of zoneGroupSeeds) {
    const existing = await db.select().from(zoneGroups).where(eq(zoneGroups.zoneGroupId, g.id));
    if (existing.length === 0) {
      await db.insert(zoneGroups).values({
        zoneGroupId: g.id,
        organizationId: ORG_ID,
        name: g.name,
        keyGroup: g.keyGroup,
        createdBy: USER_ID,
      });
      console.log(`Created zone group ${g.name}`);
    }
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
        zoneGroupId: NYC_EDS_GROUP_ID,
        name: z.name,
        keys: [],
        createdBy: USER_ID,
      });
      console.log(`Created zone ${z.name}`);
    }
  }

  const campaignSeeds: Array<{
    id: string;
    name: string;
    segmentId: string | null;
    zoneGroupId: string | null;
    scriptId: string | null;
  }> = [
    {
      id: CAMPAIGN_ID,
      name: "Default Campaign",
      segmentId: SEGMENT_ID,
      zoneGroupId: NYC_EDS_GROUP_ID,
      scriptId: SCRIPT_ID,
    },
    {
      id: PETITIONING_CAMPAIGN_ID,
      name: "Petitioning",
      segmentId: BASE_SEGMENT_ID,
      zoneGroupId: NYC_EDS_GROUP_ID,
      scriptId: SCRIPT_ID,
    },
    {
      id: PERSUASION_CAMPAIGN_ID,
      name: "Persuasion",
      segmentId: TURNOUT_SEGMENT_ID,
      zoneGroupId: NYC_EDS_GROUP_ID,
      scriptId: SCRIPT_ID,
    },
  ];
  for (const c of campaignSeeds) {
    const existing = await db.select().from(campaigns).where(eq(campaigns.campaignId, c.id));
    if (existing.length === 0) {
      await db.insert(campaigns).values({
        campaignId: c.id,
        organizationId: ORG_ID,
        name: c.name,
        segmentId: c.segmentId,
        zoneGroupId: c.zoneGroupId,
        scriptId: c.scriptId,
        createdBy: USER_ID,
      });
      console.log(`Created campaign ${c.name}`);
    }
  }

  // --- Second org ---

  const existingSecondOrg = await db
    .select()
    .from(organizations)
    .where(eq(organizations.organizationId, SECOND_ORG_ID));
  if (existingSecondOrg.length === 0) {
    await db.insert(organizations).values({
      organizationId: SECOND_ORG_ID,
      slug: "other",
      name: "Other Organization",
    });
    await db.insert(memberships).values({
      userId: USER_ID,
      organizationId: SECOND_ORG_ID,
      role: "admin",
    });
    console.log("Created second organization and admin membership");
  }

  const existingSecondQuestion = await db
    .select()
    .from(surveyQuestions)
    .where(eq(surveyQuestions.surveyQuestionId, SECOND_SURVEY_QUESTION_ID));
  if (existingSecondQuestion.length === 0) {
    await db.insert(surveyQuestions).values({
      surveyQuestionId: SECOND_SURVEY_QUESTION_ID,
      organizationId: SECOND_ORG_ID,
      text: "Do you support the bill?",
      createdBy: USER_ID,
    });
    await db.insert(surveyResponseOptions).values(
      ["Yes", "No", "Undecided"].map((text, order) => ({
        surveyResponseOptionId: SECOND_RESPONSE_OPTION_IDS[order]!,
        surveyQuestionId: SECOND_SURVEY_QUESTION_ID,
        text,
        order,
        createdBy: USER_ID,
      })),
    );
    console.log("Created second-org survey question and response options");
  }

  const existingSecondScript = await db
    .select()
    .from(scripts)
    .where(eq(scripts.scriptId, SECOND_SCRIPT_ID));
  if (existingSecondScript.length === 0) {
    await db.insert(scripts).values({
      scriptId: SECOND_SCRIPT_ID,
      organizationId: SECOND_ORG_ID,
      name: "Other Script",
      createdBy: USER_ID,
    });
    await db.insert(scriptQuestions).values({
      scriptId: SECOND_SCRIPT_ID,
      surveyQuestionId: SECOND_SURVEY_QUESTION_ID,
      order: 0,
    });
    console.log("Created second-org script");
  }

  const existingSecondSegment = await db
    .select()
    .from(segments)
    .where(eq(segments.segmentId, SECOND_SEGMENT_ID));
  if (existingSecondSegment.length === 0) {
    await db.insert(segments).values({
      segmentId: SECOND_SEGMENT_ID,
      organizationId: SECOND_ORG_ID,
      name: "Other Segment",
      criteria: { steps: [] },
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      createdBy: USER_ID,
    });
    console.log("Created second-org segment");
  }

  const existingSecondZoneGroup = await db
    .select()
    .from(zoneGroups)
    .where(eq(zoneGroups.zoneGroupId, SECOND_ZONE_GROUP_ID));
  if (existingSecondZoneGroup.length === 0) {
    await db.insert(zoneGroups).values({
      zoneGroupId: SECOND_ZONE_GROUP_ID,
      organizationId: SECOND_ORG_ID,
      name: "Other Zone Group",
      keyGroup: "nyc_eds",
      createdBy: USER_ID,
    });
    await db.insert(zones).values({
      zoneId: SECOND_ZONE_ID,
      zoneGroupId: SECOND_ZONE_GROUP_ID,
      name: "Other Zone",
      keys: [],
      createdBy: USER_ID,
    });
    console.log("Created second-org zone group and zone");
  }

  const existingSecondCampaign = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.campaignId, SECOND_CAMPAIGN_ID));
  if (existingSecondCampaign.length === 0) {
    await db.insert(campaigns).values({
      campaignId: SECOND_CAMPAIGN_ID,
      organizationId: SECOND_ORG_ID,
      name: "Other Campaign",
      segmentId: SECOND_SEGMENT_ID,
      zoneGroupId: SECOND_ZONE_GROUP_ID,
      scriptId: SECOND_SCRIPT_ID,
      createdBy: USER_ID,
    });
    console.log("Created second-org campaign");
  }

  console.log("Mock data in database.");
  process.exit(0);
}

void mock();
