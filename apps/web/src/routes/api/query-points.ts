// Web → data proxy for points-binary queries.
//
// Builds the per-org SQL (buildings whose contained persons match the
// segment filter) and forwards `{sql, params}` to the data service's
// generic `POST /query` endpoint with `Accept: application/octet-stream`,
// which causes the response to come back as raw Float32 bytes. The
// browser receives the binary stream untouched.
//
// Lives outside the oRPC handler because oRPC serializes responses as
// JSON. Sending the bytes through oRPC would force base64 (~25% wire
// overhead) plus an `atob` + per-byte loop on the browser main
// thread. Direct binary over fetch + `arrayBuffer()` skips both —
// zero JS-side decode work, the points go straight from network
// buffer to GPU buffer.

import { db, eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { type Query as QueryShape } from "../../lib/filters";
import { queryToWhere } from "../../lib/query-to-sql";
import { loadUser } from "../../rpc/context";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/query-points")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const user = await loadUser(db, request);
        const body = (await request.json()) as { query?: unknown };
        const query = (body.query ?? { filters: [] }) as QueryShape;

        const rows = await db
          .select({ slug: organizations.slug })
          .from(organizations)
          .where(eq(organizations.organizationId, user.organizationId));
        const slug = rows[0]?.slug;
        if (!slug) {
          return new Response("Organization not found", { status: 404, headers: corsHeaders });
        }

        // Buildings whose contained persons satisfy the filter. Empty
        // filter → all buildings with at least one person.
        const { where, params } = queryToWhere(query);
        const persons = `ducklake.main.${slug}_persons_geocoded`;
        const buildings = `ducklake.main.${slug}_buildings_geocoded`;
        const sql = `
          SELECT longitude, latitude
          FROM ${buildings}
          WHERE building_id IN (SELECT DISTINCT building_id FROM ${persons} ${where})
        `;

        const upstream = await fetch(`${import.meta.env.VITE_DATA_URL}/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/octet-stream",
          },
          body: JSON.stringify({ sql, params }),
        });
        if (!upstream.ok) {
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: corsHeaders,
          });
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            ...corsHeaders,
          },
        });
      },
    },
  },
});
