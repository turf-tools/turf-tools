// Inspect a custom-field upload: raw body → data service parses it and
// returns the column names or the parse error. Fully stateless — nothing is
// persisted. The dialog sends only a head slice of CSVs (the header is all
// inspect needs; DuckDB stays the one dialect sniffer) and reads parquet
// footers client-side, so the full file crosses the wire once, on append.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { hasPermission } from "~/lib/permissions";
import { dataFetch } from "~/lib/server/data-proxy";
import { buildWebContext } from "~/rpc/context";

export const Route = createFileRoute("/api/web/$orgSlug/custom-field-inspect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/custom-field-inspect$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });
        let context: Awaited<ReturnType<typeof buildWebContext>>;
        try {
          context = await buildWebContext(db, request.headers, orgSlug);
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!hasPermission(context.role, "datasets.manage")) {
          return new Response("Forbidden", { status: 403 });
        }
        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return new Response("Empty upload.", { status: 400 });
        const upstream = await dataFetch("/custom-fields/inspect", { method: "POST", body });
        const text = await upstream.text();
        if (!upstream.ok) {
          // FastAPI wraps errors as {detail} — unwrap for the dialog.
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
