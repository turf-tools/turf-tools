import { z } from "zod";
import { pub } from "./context";
import * as campaignsProcedures from "./campaigns";
import * as canvassProcedures from "./canvass";
import * as organizationsProcedures from "./organizations";
import * as scriptProcedures from "./script";
import * as segmentsProcedures from "./segments";
import * as turfsProcedures from "./turfs";
import * as zonesProcedures from "./zones";

export const router = {
  healthcheck: pub.input(z.object({}).optional()).handler(async ({ context }) => {
    await context.db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
  organizations: {
    getCurrent: organizationsProcedures.getCurrent,
  },
  campaigns: {
    list: campaignsProcedures.list,
    getById: campaignsProcedures.getById,
  },
  segments: {
    list: segmentsProcedures.list,
    getById: segmentsProcedures.getById,
  },
  zones: {
    list: zonesProcedures.list,
    getById: zonesProcedures.getById,
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
