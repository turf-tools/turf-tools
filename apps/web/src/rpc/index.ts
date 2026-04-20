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
    getByUser: turfsProcedures.getByUser,
    getById: turfsProcedures.getById,
    getByCode: turfsProcedures.getByCode,
  },
  script: {
    get: scriptProcedures.get,
  },
  canvass: {
    appendDoorResult: canvassProcedures.appendDoorResult,
    appendBuildingResult: canvassProcedures.appendBuildingResult,
    appendPersonResult: canvassProcedures.appendPersonResult,
    appendNote: canvassProcedures.appendNote,
    pull: canvassProcedures.pull,
  },
};

export type Router = typeof router;
