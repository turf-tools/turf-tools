// Web → data proxy for the binary points stream. Lives outside the oRPC
// layer because oRPC serializes responses as JSON; pushing a Float32Array
// through that path would force base64 encoding (~25% wire overhead + an
// `atob` + per-byte loop on the browser main thread). Direct binary fetch +
// `arrayBuffer()` skips both — bytes flow network → GPU buffer with no
// JS-side decode.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@field-tools/db";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildAdminContext } from "~/rpc/context";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/admin/segment-points")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        let context;
        try {
          context = await buildAdminContext(db, request.headers);
        } catch {
          return new Response("Unauthorized", { status: 401, headers: corsHeaders });
        }
        const body = (await request.json()) as {
          criteria: unknown;
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
            orgSlug: context.orgSlug,
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
