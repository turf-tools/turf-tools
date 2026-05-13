import { z } from "zod";
import { adminPub, nativePub } from "./context";
import * as campaigns from "./admin/campaigns";
import * as organizations from "./admin/organizations";
import * as script from "./admin/script";
import * as segments from "./admin/segments";
import * as turfDrafts from "./admin/turf-drafts";
import * as adminTurfs from "./admin/turfs";
import * as zoneGroups from "./admin/zone-groups";
import * as zones from "./admin/zones";
import * as canvass from "./native/canvass";
import * as nativeScript from "./native/script";
import * as nativeTurfs from "./native/turfs";

export const adminRouter = {
  healthcheck: adminPub.input(z.object({}).optional()).handler(async ({ context }) => {
    await context.db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
  organizations: {
    getCurrent: organizations.getCurrent,
  },
  campaigns: {
    list: campaigns.list,
    getById: campaigns.getById,
    create: campaigns.create,
    rename: campaigns.rename,
    update: campaigns.update,
    clone: campaigns.clone,
    remove: campaigns.remove,
  },
  segments: {
    list: segments.list,
    getById: segments.getById,
    create: segments.create,
    rename: segments.rename,
    clone: segments.clone,
    remove: segments.remove,
    countCampaigns: segments.countCampaigns,
    updateCriteria: segments.updateCriteria,
    count: segments.count,
    countCascade: segments.countCascade,
    sample: segments.sample,
    countByKey: segments.countByKey,
    listBuildings: segments.listBuildings,
  },
  zoneGroups: {
    list: zoneGroups.list,
    getById: zoneGroups.getById,
    create: zoneGroups.create,
    createWithDefaultZone: zoneGroups.createWithDefaultZone,
    rename: zoneGroups.rename,
    clone: zoneGroups.clone,
    remove: zoneGroups.remove,
    countCampaigns: zoneGroups.countCampaigns,
  },
  zones: {
    list: zones.list,
    getById: zones.getById,
    updateKeys: zones.updateKeys,
    rename: zones.rename,
    create: zones.create,
    remove: zones.remove,
    removeAllInGroup: zones.removeAllInGroup,
  },
  turfs: {
    listForOrg: adminTurfs.listForOrg,
    countForCampaign: adminTurfs.countForCampaign,
    statsForCampaign: adminTurfs.statsForCampaign,
    publish: adminTurfs.publish,
  },
  turfDrafts: {
    list: turfDrafts.list,
    replaceAll: turfDrafts.replaceAll,
  },
  script: {
    list: script.list,
  },
};

export const nativeRouter = {
  healthcheck: nativePub.input(z.object({}).optional()).handler(async ({ context }) => {
    await context.db.execute("SELECT 1 as ok");
    return { status: "ok", db: "connected" };
  }),
  turfs: {
    getById: nativeTurfs.getById,
    getByCode: nativeTurfs.getByCode,
    getData: nativeTurfs.getData,
  },
  script: {
    get: nativeScript.get,
  },
  canvass: {
    appendDoorResult: canvass.appendDoorResult,
    appendBuildingResult: canvass.appendBuildingResult,
    appendPersonResult: canvass.appendPersonResult,
    appendNote: canvass.appendNote,
    pull: canvass.pull,
  },
};

export type AdminRouter = typeof adminRouter;
export type NativeRouter = typeof nativeRouter;
