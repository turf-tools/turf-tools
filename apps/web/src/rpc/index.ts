import { z } from "zod";
import { pub } from "./context";
import * as canvassProcedures from "./canvass";
import * as listsProcedures from "./lists";
import * as organizationsProcedures from "./organizations";
import * as scriptProcedures from "./script";
import * as tracksProcedures from "./tracks";
import * as turfsProcedures from "./turfs";

export const router = {
  healthcheck: pub.input(z.object({}).optional()).handler(async ({ context }) => {
    await context.db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
  organizations: {
    getCurrent: organizationsProcedures.getCurrent,
  },
  tracks: {
    list: tracksProcedures.list,
    getById: tracksProcedures.getById,
  },
  lists: {
    list: listsProcedures.list,
    getById: listsProcedures.getById,
  },
  turfs: {
    getByUser: turfsProcedures.getByUser,
    getById: turfsProcedures.getById,
    getByCode: turfsProcedures.getByCode,
    listForOrg: turfsProcedures.listForOrg,
    getByIdForOrg: turfsProcedures.getByIdForOrg,
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
