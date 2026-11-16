// Custom-field append: browser file → synchronous ingest on the data service
// → provenance row → stats back to the dialog. Raw body (not multipart) with
// the config in query params, so the file streams through without a
// form-parsing layer; the data service is internal and the browser only ever
// talks to this edge. The upload id is minted here and passed down so lake
// rows carry it; the provenance row is inserted only after ingest succeeds —
// failed appends write nothing anywhere.

import { createFileRoute } from "@tanstack/react-router";
import { and, db, eq } from "@turf-tools/db";
import {
  type CustomFieldType,
  customFieldUploads,
  datasetOrganizations,
  datasets,
} from "@turf-tools/db/schema";
import { dataFetch } from "~/lib/server/data-proxy";
import { buildPermittedContext } from "~/rpc/context";

const FIELD_TYPES: CustomFieldType[] = [
  "number",
  "date",
  "text",
  "text_multi",
  "enum",
  "enum_multi",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Worst realistic append is a full-population two-column CSV (~100–150MB for
// 5M rows); typical lists are well under 15MB. Cap well above the worst case.
const MAX_BODY_BYTES = 250 * 1024 * 1024;

type AppendStats = {
  fields: string[];
  customFieldId: string;
  rowCount: number;
  skippedCount: number;
  matchedCount: number | null;
};

export const Route = createFileRoute("/api/web/$orgSlug/custom-field-append")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/custom-field-append$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildPermittedContext>>;
        try {
          context = await buildPermittedContext(db, request.headers, orgSlug, "datasets.manage");
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const datasetId = url.searchParams.get("datasetId");
        const fieldType = url.searchParams.get("fieldType") as CustomFieldType | null;
        // Optional rename of a new field; defaults to the value column header.
        const label = url.searchParams.get("label")?.trim() || null;
        const filename = url.searchParams.get("filename") || null;
        // Merge or replace into an existing field; absent → a new field.
        const customFieldId = url.searchParams.get("customFieldId") || null;
        const replace = url.searchParams.get("replace") === "true";
        if (
          !datasetId ||
          !fieldType ||
          !FIELD_TYPES.includes(fieldType) ||
          (customFieldId != null && !UUID_RE.test(customFieldId))
        ) {
          return new Response("Bad Request", { status: 400 });
        }

        const [grant] = await db
          .select({ slug: datasets.slug })
          .from(datasetOrganizations)
          .innerJoin(datasets, eq(datasets.datasetId, datasetOrganizations.datasetId))
          .where(
            and(
              eq(datasetOrganizations.datasetId, datasetId),
              eq(datasetOrganizations.organizationId, context.organizationId),
            ),
          );
        if (!grant) return new Response("Not Found", { status: 404 });

        const body = await request.arrayBuffer();
        if (body.byteLength === 0) return new Response("Empty upload.", { status: 400 });
        if (body.byteLength > MAX_BODY_BYTES) {
          return new Response("File is too large to append.", { status: 413 });
        }

        const customFieldUploadId = crypto.randomUUID();
        const params = new URLSearchParams({
          datasetId,
          datasetSlug: grant.slug,
          fieldType,
          uploadId: customFieldUploadId,
        });
        if (label) params.set("label", label);
        if (customFieldId) params.set("customFieldId", customFieldId);
        if (replace) params.set("replace", "true");
        const upstream = await dataFetch(`/custom-fields/append?${params.toString()}`, {
          method: "POST",
          body,
        });
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
        const stats = JSON.parse(text) as AppendStats;

        await db.insert(customFieldUploads).values({
          customFieldUploadId,
          datasetId,
          filename,
          customFieldId: stats.customFieldId,
          rowCount: stats.rowCount,
          skippedCount: stats.skippedCount,
          matchedCount: stats.matchedCount,
          createdBy: context.user.id,
        });

        return Response.json(stats);
      },
    },
  },
});
