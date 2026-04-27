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
import { boundaryKeyExprFor } from "../../lib/key-groups";
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
        const body = (await request.json()) as {
          query?: unknown;
          // Optional scope constraint: limits the result to people
          // whose boundary-key falls in the supplied set. Used by the
          // campaign editor to clip the points layer to the bound
          // zone group's zones (segment ∩ zone group).
          keyFilter?: { keyGroup: string; keys: string[] };
        };
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

        // Compose the inner persons-WHERE: the segment filters plus,
        // if a keyFilter is supplied, an additional `IN (...)` on the
        // boundary-key column. Empty `keys` short-circuits to "no
        // matches" — return zero buildings rather than letting an
        // empty IN-list become a SQL error.
        let innerWhere = where;
        const innerParams = [...params];
        if (body.keyFilter) {
          if (body.keyFilter.keys.length === 0) {
            return new Response(new Uint8Array(0), {
              status: 200,
              headers: { "Content-Type": "application/octet-stream", ...corsHeaders },
            });
          }
          const expr = boundaryKeyExprFor(body.keyFilter.keyGroup);
          const placeholders = body.keyFilter.keys.map(() => "?").join(", ");
          const clause = `${expr} IN (${placeholders})`;
          innerWhere = innerWhere ? `${innerWhere} AND ${clause}` : `WHERE ${clause}`;
          innerParams.push(...body.keyFilter.keys);
        }

        const sql = `
          SELECT longitude, latitude
          FROM ${buildings}
          WHERE building_id IN (SELECT DISTINCT building_id FROM ${persons} ${innerWhere})
        `;

        const upstream = await fetch(`${import.meta.env.VITE_DATA_URL}/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/octet-stream",
          },
          body: JSON.stringify({ sql, params: innerParams }),
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
