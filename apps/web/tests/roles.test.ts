import { createRouterClient, ORPCError } from "@orpc/server";
import { SEEDED_ADMIN_USER_ID, SEEDED_ORG_ID, type Db } from "@turf-tools/db";
import { test, expect } from "vite-plus/test";
import { webRouter } from "../src/rpc";
import type { WebContext } from "../src/rpc/context";

// Every call here is refused by the permission or rank gate before any
// query runs, so the context carries no real database.
function callerAs(role: string) {
  const context: WebContext = {
    db: {} as Db,
    user: {
      id: SEEDED_ADMIN_USER_ID,
      email: "admin@turf.tools",
      displayEmail: "admin@turf.tools",
      emailVerified: true,
      name: "Admin User",
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
      displayTimezone: null,
    },
    organizationId: SEEDED_ORG_ID,
    orgSlug: "default",
    role,
  };
  return createRouterClient(webRouter, { context });
}

async function forbidden(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof ORPCError && e.code === "FORBIDDEN";
  }
}

test("a procedure refuses roles without its permission", async () => {
  const lead = callerAs("lead");
  expect(await forbidden(lead.users.list())).toBe(true);
  expect(await forbidden(lead.segments.list())).toBe(true);
  expect(await forbidden(lead.turfs.publish({ campaignId: SEEDED_ORG_ID, zoneId: null }))).toBe(
    true,
  );
});

test("unknown roles hold nothing", async () => {
  expect(await forbidden(callerAs("member").users.list())).toBe(true);
});

test("inviting above your rank is refused", async () => {
  const admin = callerAs("admin");
  expect(await forbidden(admin.users.invite({ email: "a@b.co", role: "owner" }))).toBe(true);
});
