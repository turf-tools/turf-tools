import { createRouterClient } from "@orpc/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@field-tools/db";
import { test } from "vite-plus/test";
import { router } from "../src/rpc";
import { SEEDED_ADMIN_USER_ID, type User } from "../src/rpc/context";

export async function getTestClient() {
  // Each test gets a fresh in-memory database
  const pglite = new PGlite();
  const db = drizzle({ client: pglite, casing: "snake_case" }) as unknown as Db;

  const user: User = {
    userId: SEEDED_ADMIN_USER_ID,
    organizationId: "00000000-0000-0000-0000-000000000001",
    email: "admin@field.tools",
    firstName: "Admin",
    lastName: "User",
    role: "admin",
    createdAt: new Date(),
  };

  const caller = createRouterClient(router, {
    context: { db, user },
  });

  const stop = async () => {
    await pglite.close();
  };

  return { caller, db, stop };
}

export const rpcTest = test.extend<{
  rpc: Awaited<ReturnType<typeof getTestClient>>;
}>({
  // eslint-disable-next-line no-empty-pattern
  rpc: async ({}, use) => {
    const testClient = await getTestClient();
    await use(testClient);
    await testClient.stop();
  },
});
