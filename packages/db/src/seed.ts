import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "./index";
import { JOB_STATUSES, jobStatus } from "./schema/jobs";

export async function seedJobStatuses(database: Db = defaultDb) {
  for (const status of JOB_STATUSES) {
    const existing = await database.select().from(jobStatus).where(eq(jobStatus.status, status));
    if (existing.length === 0) {
      await database.insert(jobStatus).values({ status });
    }
  }
}

export async function seedReferenceData(database: Db = defaultDb) {
  await seedJobStatuses(database);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedReferenceData();
}
