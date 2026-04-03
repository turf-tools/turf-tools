import { os } from "@orpc/server";
import { db } from "@turf/db";

import { z } from "zod";

// Base procedure — all procedures will build on this
const pub = os.route({ method: "GET" });

export const router = {
  healthcheck: pub.input(z.object({}).optional()).handler(async () => {
    await db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
};

export type Router = typeof router;
