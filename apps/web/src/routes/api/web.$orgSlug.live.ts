// SSE stream nudging the turfs board to refetch the moment a scan or
// walk mutation lands, instead of waiting out the poll interval. Lives
// outside oRPC because oRPC responses are one-shot JSON; this is a
// long-lived text/event-stream. Events carry no payload — the client
// just invalidates its queries, so the poll stays the source of truth
// and a dropped stream (backgrounded phone tab) degrades to polling.
// EventSource reconnects on its own.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { subscribe } from "~/lib/server/live";
import { buildWebContext } from "~/rpc/context";

const HEARTBEAT_MS = 25_000;

export const Route = createFileRoute("/api/web/$orgSlug/live")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/web\/([^/]+)\/live$/);
        const orgSlug = match?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });
        let context;
        try {
          context = await buildWebContext(db, request.headers, orgSlug);
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const organizationId = context.organizationId;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const send = (chunk: string) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                closed = true;
              }
            };
            send("retry: 3000\n\n");
            const unsubscribe = subscribe(organizationId, () => send("data: refresh\n\n"));
            // Comment-frame heartbeat keeps intermediaries from timing
            // out the idle connection.
            const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
            request.signal.addEventListener("abort", () => {
              closed = true;
              clearInterval(heartbeat);
              unsubscribe();
              try {
                controller.close();
              } catch {
                // Already closed by the runtime.
              }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
