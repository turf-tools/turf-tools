import { z } from "zod";
import { pub } from "./context";
import * as campaignsProcedures from "./campaigns";
import * as canvassProcedures from "./canvass";
import * as organizationsProcedures from "./organizations";
import * as scriptProcedures from "./script";
import * as segmentsProcedures from "./segments";
import * as turfsProcedures from "./turfs";
import * as zoneGroupsProcedures from "./zone-groups";
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
    create: segmentsProcedures.create,
    rename: segmentsProcedures.rename,
    clone: segmentsProcedures.clone,
    remove: segmentsProcedures.remove,
    countCampaigns: segmentsProcedures.countCampaigns,
    updateQuery: segmentsProcedures.updateQuery,
    queryCounts: segmentsProcedures.queryCounts,
    queryCountsByKey: segmentsProcedures.queryCountsByKey,
  },
  zoneGroups: {
    list: zoneGroupsProcedures.list,
    getById: zoneGroupsProcedures.getById,
    create: zoneGroupsProcedures.create,
    rename: zoneGroupsProcedures.rename,
    clone: zoneGroupsProcedures.clone,
    remove: zoneGroupsProcedures.remove,
    countCampaigns: zoneGroupsProcedures.countCampaigns,
  },
  zones: {
    list: zonesProcedures.list,
    getById: zonesProcedures.getById,
    updateKeys: zonesProcedures.updateKeys,
    rename: zonesProcedures.rename,
    create: zonesProcedures.create,
    remove: zonesProcedures.remove,
    removeAllInGroup: zonesProcedures.removeAllInGroup,
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
