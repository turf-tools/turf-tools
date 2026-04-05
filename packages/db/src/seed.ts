import { eq } from "drizzle-orm";
import { db } from "./index";
import { organizations } from "./schema/organizations";
import { users } from "./schema/users";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000001";

async function seed() {
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
      email: "admin@turf.tools",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
    });
    console.log("Created default user");
  }

  console.log("Seed complete.");
  process.exit(0);
}

void seed();
