// Web → data proxy for the binary points stream. Lives outside the
// oRPC layer because oRPC serializes responses as JSON; pushing a
// Float32Array through that path would force base64 encoding (~25%
// wire overhead + an `atob` + per-byte loop on the browser main
// thread). Direct binary fetch + `arrayBuffer()` skips both — bytes
// flow network → GPU buffer with no JS-side decode.
//
// Org slug is server-controlled (hardcoded for the single-org/no-auth
// state, swapped for a session lookup once auth lands).

import { createFileRoute } from "@tanstack/react-router";
import { dataFetch, passthrough } from "~/lib/data-proxy";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ORG_SLUG = "default";

export const Route = createFileRoute("/api/segment-points")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          criteria?: unknown;
          keyFilter?: { keyGroup: string; keys: string[] } | null;
        };
        const upstream = await dataFetch("/buildings/points", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/octet-stream",
          },
          body: JSON.stringify({
            criteria: body.criteria,
            keyFilter: body.keyFilter,
            orgSlug: ORG_SLUG,
          }),
        });
        if (!upstream.ok) {
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: corsHeaders,
          });
        }
        return passthrough(upstream, corsHeaders);
      },
    },
  },
});
