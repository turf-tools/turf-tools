import { createRouterClient } from "@orpc/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@field-tools/db";
import { test } from "vite-plus/test";
import { router } from "../src/rpc";

export async function getTestClient() {
  // Each test gets a fresh in-memory database
  const pglite = new PGlite();
  const db = drizzle({ client: pglite, casing: "snake_case" }) as unknown as Db;

  const caller = createRouterClient(router, {
    context: { db },
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
