import { eq } from "drizzle-orm";
import { db } from "./index";
import { lists } from "./schema/lists";
import { organizations } from "./schema/organizations";
import { scripts, scriptQuestions } from "./schema/scripts";
import { surveyQuestions, surveyResponseOptions } from "./schema/surveys";
import { tracks } from "./schema/tracks";
import { turfs } from "./schema/turfs";
import { users } from "./schema/users";

// Deterministic ids so this script is idempotent and other services (e.g. the
// data service's mock script) can reference them without a lookup. Shaped as
// valid UUID v4 (version nibble = 4, variant nibble = 8) so Zod's strict
// `.uuid()` validator accepts them.
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const TRACK_ID = "00000000-0000-4000-8000-000000000002";
const SURVEY_QUESTION_ID = "00000000-0000-4000-8000-000000000003";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000004";
const LIST_ID = "00000000-0000-4000-8000-000000000005";
const TURF_ID = "00000000-0000-4000-8000-000000000006";

// Extra tracks + lists for exercising the admin UI. These are not
// referenced by the native app (which pins to the four ids above); they
// exist only to give the tracks and lists tables more than one row and
// to cover the case where a list belongs to a track other than the default.
const SPRING_PRIMARY_TRACK_ID = "00000000-0000-4000-8000-000000000007";
const FALL_GENERAL_TRACK_ID = "00000000-0000-4000-8000-000000000008";
const SWING_LIST_ID = "00000000-0000-4000-8000-000000000009";
const BASE_LIST_ID = "00000000-0000-4000-8000-00000000000a";
const TURNOUT_LIST_ID = "00000000-0000-4000-8000-00000000000b";

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

  const existingTrack = await db.select().from(tracks).where(eq(tracks.trackId, TRACK_ID));
  if (existingTrack.length === 0) {
    await db.insert(tracks).values({
      trackId: TRACK_ID,
      organizationId: ORG_ID,
      name: "Default Track",
      createdBy: USER_ID,
    });
    console.log("Created default track");
  }

  const existingSpring = await db
    .select()
    .from(tracks)
    .where(eq(tracks.trackId, SPRING_PRIMARY_TRACK_ID));
  if (existingSpring.length === 0) {
    await db.insert(tracks).values({
      trackId: SPRING_PRIMARY_TRACK_ID,
      organizationId: ORG_ID,
      name: "Spring Primary",
      createdBy: USER_ID,
    });
    console.log("Created Spring Primary track");
  }

  const existingFall = await db
    .select()
    .from(tracks)
    .where(eq(tracks.trackId, FALL_GENERAL_TRACK_ID));
  if (existingFall.length === 0) {
    await db.insert(tracks).values({
      trackId: FALL_GENERAL_TRACK_ID,
      organizationId: ORG_ID,
      name: "Fall General",
      createdBy: USER_ID,
    });
    console.log("Created Fall General track");
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
      trackId: TRACK_ID,
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

  const existingList = await db.select().from(lists).where(eq(lists.listId, LIST_ID));
  if (existingList.length === 0) {
    await db.insert(lists).values({
      listId: LIST_ID,
      trackId: TRACK_ID,
      organizationId: ORG_ID,
      name: "Default List",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      createdBy: USER_ID,
    });
    console.log("Created default list");
  }

  const existingSwing = await db.select().from(lists).where(eq(lists.listId, SWING_LIST_ID));
  if (existingSwing.length === 0) {
    await db.insert(lists).values({
      listId: SWING_LIST_ID,
      trackId: TRACK_ID,
      organizationId: ORG_ID,
      name: "Swing Voters",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 1247,
      personCount: 2980,
      createdBy: USER_ID,
    });
    console.log("Created Swing Voters list");
  }

  const existingBase = await db.select().from(lists).where(eq(lists.listId, BASE_LIST_ID));
  if (existingBase.length === 0) {
    await db.insert(lists).values({
      listId: BASE_LIST_ID,
      trackId: SPRING_PRIMARY_TRACK_ID,
      organizationId: ORG_ID,
      name: "Base Voters",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 856,
      personCount: 1920,
      createdBy: USER_ID,
    });
    console.log("Created Base Voters list");
  }

  const existingTurnout = await db.select().from(lists).where(eq(lists.listId, TURNOUT_LIST_ID));
  if (existingTurnout.length === 0) {
    await db.insert(lists).values({
      listId: TURNOUT_LIST_ID,
      trackId: FALL_GENERAL_TRACK_ID,
      organizationId: ORG_ID,
      name: "Turnout Targets",
      voterFileId: DEFAULT_VOTER_FILE_ID,
      voterFileVersion: DEFAULT_VOTER_FILE_VERSION,
      doorCount: 3456,
      personCount: 7890,
      createdBy: USER_ID,
    });
    console.log("Created Turnout Targets list");
  }

  const existingTurf = await db.select().from(turfs).where(eq(turfs.turfId, TURF_ID));
  if (existingTurf.length === 0) {
    await db.insert(turfs).values({
      turfId: TURF_ID,
      trackId: TRACK_ID,
      listId: LIST_ID,
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
