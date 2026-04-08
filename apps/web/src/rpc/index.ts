import { z } from "zod";
import { pub } from "./context";
import * as turfsProcedures from "./turfs";
import * as scriptProcedures from "./script";
import * as canvassProcedures from "./canvass";

export const router = {
  healthcheck: pub.input(z.object({}).optional()).handler(async ({ context }) => {
    await context.db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
  turfs: {
    getMine: turfsProcedures.getMine,
    get: turfsProcedures.get,
  },
  script: {
    get: scriptProcedures.get,
  },
  canvass: {
    submitDoorResult: canvassProcedures.submitDoorResult,
  },
};

export type Router = typeof router;
