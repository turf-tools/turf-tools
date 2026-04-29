import { z } from "zod";
import { pub } from "./context";
import * as campaignsProcedures from "./campaigns";
import * as canvassProcedures from "./canvass";
import * as organizationsProcedures from "./organizations";
import * as scriptProcedures from "./script";
import * as segmentsProcedures from "./segments";
import * as turfDraftsProcedures from "./turf-drafts";
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
    create: campaignsProcedures.create,
    rename: campaignsProcedures.rename,
    update: campaignsProcedures.update,
    clone: campaignsProcedures.clone,
    remove: campaignsProcedures.remove,
  },
  segments: {
    list: segmentsProcedures.list,
    getById: segmentsProcedures.getById,
    create: segmentsProcedures.create,
    rename: segmentsProcedures.rename,
    clone: segmentsProcedures.clone,
    remove: segmentsProcedures.remove,
    countCampaigns: segmentsProcedures.countCampaigns,
    updateCriteria: segmentsProcedures.updateCriteria,
    count: segmentsProcedures.count,
    countByKey: segmentsProcedures.countByKey,
    listBuildings: segmentsProcedures.listBuildings,
  },
  zoneGroups: {
    list: zoneGroupsProcedures.list,
    getById: zoneGroupsProcedures.getById,
    create: zoneGroupsProcedures.create,
    createWithDefaultZone: zoneGroupsProcedures.createWithDefaultZone,
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
    getById: turfsProcedures.getById,
    getByCode: turfsProcedures.getByCode,
    listForOrg: turfsProcedures.listForOrg,
    getData: turfsProcedures.getData,
    statsForCampaign: turfsProcedures.statsForCampaign,
    publish: turfsProcedures.publish,
  },
  turfDrafts: {
    list: turfDraftsProcedures.list,
    replaceAll: turfDraftsProcedures.replaceAll,
  },
  script: {
    list: scriptProcedures.list,
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
