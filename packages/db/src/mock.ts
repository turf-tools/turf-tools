import { eq } from "drizzle-orm";
import { db } from "./index";
import { campaigns } from "./schema/campaigns";
import { organizations } from "./schema/organizations";
import { scripts, scriptQuestions } from "./schema/scripts";
import { surveyQuestions, surveyResponseOptions } from "./schema/surveys";
import { turfs } from "./schema/turfs";
import { universes } from "./schema/universes";
import { users } from "./schema/users";

// Deterministic ids so this script is idempotent and other services (e.g. the
// data service's mock script) can reference them without a lookup. Shaped as
// valid UUID v4 (version nibble = 4, variant nibble = 8) so Zod's strict
// `.uuid()` validator accepts them.
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";
const SURVEY_QUESTION_ID = "00000000-0000-4000-8000-000000000003";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000004";
const UNIVERSE_ID = "00000000-0000-4000-8000-000000000005";
const TURF_ID = "00000000-0000-4000-8000-000000000006";

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
      name: "Default Organization",
    });
    console.log("Created default organization");
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
    console.log("Created default user");
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
    console.log("Created default campaign");
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
    console.log("Created default survey question and response options");
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
    console.log("Created default script");
  }

  const existingUniverse = await db
    .select()
    .from(universes)
    .where(eq(universes.universeId, UNIVERSE_ID));
  if (existingUniverse.length === 0) {
    await db.insert(universes).values({
      universeId: UNIVERSE_ID,
      organizationId: ORG_ID,
      name: "Default Universe",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      createdBy: USER_ID,
    });
    console.log("Created default universe");
  }

  const existingTurf = await db.select().from(turfs).where(eq(turfs.turfId, TURF_ID));
  if (existingTurf.length === 0) {
    await db.insert(turfs).values({
      turfId: TURF_ID,
      campaignId: CAMPAIGN_ID,
      universeId: UNIVERSE_ID,
      scriptId: SCRIPT_ID,
      name: "Default Turf",
      listCode: "121121",
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
