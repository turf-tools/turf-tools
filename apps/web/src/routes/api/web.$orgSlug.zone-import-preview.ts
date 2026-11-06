// Zone import, step one: browser file → data service parse against the zone
// group's key group → zone definitions and skip counts back to the dialog.
// Nothing is written here; the dialog applies the parsed zones through
// `zones.replaceGroup` once the user confirms. Raw body (not multipart),
// like the custom-field append route.

import { createFileRoute } from "@tanstack/react-router";
import { and, db, eq } from "@turf-tools/db";
import { zoneGroups } from "@turf-tools/db/schema";
import { dataFetch } from "~/lib/server/data-proxy";
import { buildPermittedContext } from "~/rpc/context";

// A full city's worth of ED rows is well under 1MB.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export const Route = createFileRoute("/api/web/$orgSlug/zone-import-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/zone-import-preview$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildPermittedContext>>;
        try {
          context = await buildPermittedContext(db, request.headers, orgSlug, "zones.write");
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const zoneGroupId = url.searchParams.get("zoneGroupId");
        if (!zoneGroupId) return new Response("Bad Request", { status: 400 });
        const [group] = await db
          .select({ keyGroup: zoneGroups.keyGroup })
          .from(zoneGroups)
          .where(
            and(
              eq(zoneGroups.zoneGroupId, zoneGroupId),
              eq(zoneGroups.organizationId, context.organizationId),
            ),
          );
        if (!group) return new Response("Not Found", { status: 404 });

        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return new Response("Empty upload.", { status: 400 });
        if (body.byteLength > MAX_BODY_BYTES) {
          return new Response("File is too large to import.", { status: 413 });
        }

        const params = new URLSearchParams({ orgSlug: context.orgSlug, keyGroup: group.keyGroup });
        const upstream = await dataFetch(`/zones/parse?${params.toString()}`, {
          method: "POST",
          body,
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          // FastAPI wraps errors as {detail}: unwrap for the dialog.
          try {
            const parsed = JSON.parse(text) as { detail?: string };
            return new Response(parsed.detail ?? text, { status: upstream.status });
          } catch {
            return new Response(text, { status: upstream.status });
          }
        }
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
