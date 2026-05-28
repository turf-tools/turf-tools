import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import type { GeoJsonPolygon } from "./turfs";

// In-progress turf cuts for the cutter UI. One row per drafted
// polygon, scoped to a `(campaignId, zoneId)` pair — two campaigns
// can cut the same zone differently.
//
// `turfDraftId` is client-generated (matches the in-memory `Turf.id`
// in the cutter). The save flow is "replace all": every save
// transactionally wipes drafts for `(campaignId, zoneId)` and inserts
// the current array, so there's no per-row create-vs-update bookkeeping
// the client has to track.
//
// `zoneId` and `segmentId` are stored as plain uuids (not FKs) — same
// reasoning as `turfs`: drafts are working state for the cutter, but
// neither zones nor segments should cascade-delete drafts (admin can
// reorganize zones/segments independently). `campaignId` *is* an FK
// with cascade since drafts are meaningless without their parent
// campaign.
//
// `zoneId` is nullable so the cutter can produce drafts on campaigns
// without a zone group (scope = whole segment).
export const turfDrafts = pgTable(
  "turf_drafts",
  {
    turfDraftId: uuid().primaryKey(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.campaignId, { onDelete: "cascade" }),
    zoneId: uuid(),
    segmentId: uuid().notNull(),
    // GeoJSON Polygon — interoperable with PostGIS / turf.js / mapbox-gl.
    // The cutter's in-memory shape is a flat `[[lng,lat],...]`; we
    // convert to/from GeoJSON at the save/read boundary.
    geometry: jsonb().$type<GeoJsonPolygon>().notNull(),
    name: text(),
    sortOrder: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("turf_drafts_scope_idx").on(t.campaignId, t.zoneId)],
);
