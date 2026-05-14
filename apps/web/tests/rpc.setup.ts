import { createRouterClient } from "@orpc/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SEEDED_ADMIN_USER_ID, SEEDED_ORG_ID, type Db } from "@field-tools/db";
import { test } from "vite-plus/test";
import { webRouter } from "../src/rpc";
import type { WebContext, User } from "../src/rpc/context";

export async function getTestClient() {
  // Each test gets a fresh in-memory database. Tests that need real schema
  // are responsible for creating/seeding the tables they touch — the setup
  // here only stands up an empty Postgres-compatible db + an admin context.
  const pglite = new PGlite();
  const db = drizzle({ client: pglite, casing: "snake_case" }) as unknown as Db;

  const user: User = {
    id: SEEDED_ADMIN_USER_ID,
    email: "admin@field.tools",
    emailVerified: true,
    name: "Admin User",
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };

  const context: WebContext = {
    db,
    user,
    organizationId: SEEDED_ORG_ID,
    orgSlug: "default",
    role: "owner",
  };

  const caller = createRouterClient(webRouter, { context });

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
