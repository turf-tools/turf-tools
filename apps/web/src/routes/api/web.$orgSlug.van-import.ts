// VAN survey import edge: multipart POST → runVanResponseImport.
//
// Fields: `idMap` (Standard Text StateFileID ↔ VANID), `survey` (long-format
// survey-results export), `mappings` (JSON: create / match-to-questionId per
// SurveyQuestionId; skipped questions are simply omitted). Auth is
// scripts.write — same gate as editing the questions catalog. Outside oRPC
// because the payload is two large files, not JSON.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { runVanResponseImport, type VanQuestionMapping } from "~/lib/server/van-import-run";
import { buildPermittedContext } from "~/rpc/context";

// Same order of magnitude as custom-field append; survey exports can be large.
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/web/$orgSlug/van-import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/van-import$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildPermittedContext>>;
        try {
          context = await buildPermittedContext(db, request.headers, orgSlug, "scripts.write");
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("Expected multipart form data.", { status: 400 });
        }

        const idMapFile = form.get("idMap");
        const surveyFile = form.get("survey");
        if (!(idMapFile instanceof File) || !(surveyFile instanceof File)) {
          return new Response("Missing idMap or survey file.", { status: 400 });
        }
        if (idMapFile.size === 0 || surveyFile.size === 0) {
          return new Response("Empty upload.", { status: 400 });
        }
        if (idMapFile.size > MAX_FILE_BYTES || surveyFile.size > MAX_FILE_BYTES) {
          return new Response("File is too large to import.", { status: 413 });
        }

        // questionId null → create (or reuse by vanId); string → match that org question.
        const mappingsRaw = form.get("mappings");
        if (typeof mappingsRaw !== "string" || !mappingsRaw.trim()) {
          return new Response("Missing mappings.", { status: 400 });
        }
        let mappings: VanQuestionMapping[];
        try {
          const parsed = JSON.parse(mappingsRaw) as unknown;
          if (!Array.isArray(parsed)) throw new Error("bad");
          mappings = parsed.map((row) => {
            const m = row as { questionVanId?: unknown; questionId?: unknown };
            if (typeof m.questionVanId !== "string" || !m.questionVanId) {
              throw new Error("bad questionVanId");
            }
            if (m.questionId != null) {
              if (typeof m.questionId !== "string" || !UUID_RE.test(m.questionId)) {
                throw new Error("bad questionId");
              }
              return { questionVanId: m.questionVanId, questionId: m.questionId };
            }
            return { questionVanId: m.questionVanId, questionId: null };
          });
        } catch {
          return new Response("Invalid mappings JSON.", { status: 400 });
        }

        try {
          const stats = await runVanResponseImport(db, {
            organizationId: context.organizationId,
            orgSlug: context.orgSlug,
            userId: context.user.id,
            idMapBuffer: await idMapFile.arrayBuffer(),
            surveyBuffer: await surveyFile.arrayBuffer(),
            mappings,
          });
          return Response.json(stats);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Import failed.";
          return new Response(message, { status: 400 });
        }
      },
    },
  },
});
