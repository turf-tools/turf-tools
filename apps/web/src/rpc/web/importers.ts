import { ORPCError } from "@orpc/server";
import type { ImportFilter } from "@turf-tools/db/schema";
import { z } from "zod";
import { cleanSources, findImporter, type ImporterSpec, isReadableSource } from "~/lib/importers";
import { dataGetJson } from "~/lib/server/data-proxy";
import { webPub } from "../context";

const pub = webPub("datasets.read");

// The registry only changes when the data server is redeployed; a short TTL
// lets a new importer appear without restarting web.
const TTL_MS = 60_000;
let cached: { at: number; importers: ImporterSpec[] } | null = null;

export async function getImporters(): Promise<ImporterSpec[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.importers;
  const importers = await dataGetJson<ImporterSpec[]>("/importers");
  cached = { at: Date.now(), importers };
  return importers;
}

// The importer, sources, and filter an import may run with, checked against the
// registry the way the importer's own `check_import_inputs` does. Returns the
// sources with blank optional entries dropped.
export async function checkImportInputs(
  name: string,
  sources: Record<string, string>,
  filter: ImportFilter | null,
): Promise<Record<string, string>> {
  const importer = findImporter(await getImporters(), name);
  if (!importer) throw new ORPCError("BAD_REQUEST", { message: "Unknown dataset type." });
  const cleaned = cleanSources(sources);
  if (Object.keys(cleaned).some((k) => !importer.sources.some((s) => s.key === k)))
    throw new ORPCError("BAD_REQUEST", { message: "That file isn't read by this dataset type." });
  const missing = importer.sources.filter((s) => s.required && !cleaned[s.key]);
  if (missing.length > 0)
    throw new ORPCError("BAD_REQUEST", {
      message: `Missing ${missing.map((s) => s.label).join(", ")}.`,
    });
  const unreadable = importer.sources.filter((s) => !isReadableSource(cleaned[s.key] ?? ""));
  if (unreadable.length > 0)
    throw new ORPCError("BAD_REQUEST", {
      message: `${unreadable.map((s) => s.label).join(", ")} must be an http:// or https:// link.`,
    });
  if (filter && !importer.filters.some((f) => f.column === filter.column))
    throw new ORPCError("BAD_REQUEST", {
      message: "That filter field isn't available for this dataset type.",
    });
  return cleaned;
}

export const list = pub.input(z.object({}).optional()).handler(() => getImporters());
