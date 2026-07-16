import { eq } from "drizzle-orm";
import { db } from "./index";
import { SEEDED_ADMIN_USER_ID, SEEDED_ORG_ID } from "./ids";
import { seedReferenceData } from "./seed";
import { memberships } from "./schema/memberships";
import { organizations } from "./schema/organizations";
import { scripts, scriptSteps } from "./schema/scripts";
import { questions, responseOptions } from "./schema/questions";
import { users } from "./schema/auth/users";

// Deterministic ids so this script is idempotent and other services (e.g. the
// data service's mock script) can reference them without a lookup. Shaped as
// valid UUID v4 (version nibble = 4, variant nibble = 8) so Zod's strict
// `.uuid()` validator accepts them.
const ORG_ID = SEEDED_ORG_ID;
const USER_ID = SEEDED_ADMIN_USER_ID;
const QUESTION_ID = "00000000-0000-4000-8000-000000000003";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000004";

// Second org for exercising multi-tenancy. The admin user is added with
// role "admin" (not "owner") so the per-org permission check is visible
// in the UI — Users tab disappears when switched to this org.
const SECOND_ORG_ID = "00000000-0000-4000-8000-000000000020";
const SECOND_QUESTION_ID = "00000000-0000-4000-8000-000000000021";
const SECOND_SCRIPT_ID = "00000000-0000-4000-8000-000000000022";
const SECOND_RESPONSE_OPTION_IDS = [
  "00000000-0000-4000-8000-000000000040",
  "00000000-0000-4000-8000-000000000041",
  "00000000-0000-4000-8000-000000000042",
];

const RESPONSE_OPTIONS: Array<{ id: string; text: string }> = [
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
    const seedEmail = process.env.SEED_USER_EMAIL ?? "admin@field.tools";
    await db.insert(users).values({
      id: USER_ID,
      email: seedEmail,
      displayEmail: process.env.SEED_USER_DISPLAY_EMAIL ?? seedEmail,
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
    .from(questions)
    .where(eq(questions.questionId, QUESTION_ID));
  if (existingQuestion.length === 0) {
    await db.insert(questions).values({
      questionId: QUESTION_ID,
      organizationId: ORG_ID,
      name: "Candidate support",
      responseType: "single_select",
      text: "Are you planning to vote for our candidate?",
      createdBy: USER_ID,
    });
    await db.insert(responseOptions).values(
      RESPONSE_OPTIONS.map((opt, order) => ({
        responseOptionId: opt.id,
        questionId: QUESTION_ID,
        text: opt.text,
        order,
        createdBy: USER_ID,
      })),
    );
    console.log("Created question and response options");
  }

  const existingScript = await db.select().from(scripts).where(eq(scripts.scriptId, SCRIPT_ID));
  if (existingScript.length === 0) {
    await db.insert(scripts).values({
      scriptId: SCRIPT_ID,
      organizationId: ORG_ID,
      name: "Default Script",
      createdBy: USER_ID,
    });
    await db.insert(scriptSteps).values({
      scriptId: SCRIPT_ID,
      order: 0,
      stepType: "question",
      questionId: QUESTION_ID,
    });
    console.log("Created script");
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
    .from(questions)
    .where(eq(questions.questionId, SECOND_QUESTION_ID));
  if (existingSecondQuestion.length === 0) {
    await db.insert(questions).values({
      questionId: SECOND_QUESTION_ID,
      organizationId: SECOND_ORG_ID,
      name: "Bill support",
      responseType: "single_select",
      text: "Do you support the bill?",
      createdBy: USER_ID,
    });
    await db.insert(responseOptions).values(
      ["Yes", "No", "Undecided"].map((text, order) => ({
        responseOptionId: SECOND_RESPONSE_OPTION_IDS[order]!,
        questionId: SECOND_QUESTION_ID,
        text,
        order,
        createdBy: USER_ID,
      })),
    );
    console.log("Created second-org question and response options");
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
    await db.insert(scriptSteps).values([
      {
        scriptId: SECOND_SCRIPT_ID,
        order: 0,
        stepType: "text",
        text: "Hi, I'm canvassing for the campaign — got a moment?",
      },
      {
        scriptId: SECOND_SCRIPT_ID,
        order: 1,
        stepType: "question",
        questionId: SECOND_QUESTION_ID,
      },
    ]);
    console.log("Created second-org script");
  }

  console.log("Mock data in database.");
  process.exit(0);
}

void mock();
