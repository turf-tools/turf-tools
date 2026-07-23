import { ORPCError } from "@orpc/server";
import { and, arrayContains, asc, desc, eq } from "@turf-tools/db";
import {
  customFields,
  customFieldUploads,
  datasetOrganizations,
  datasets,
} from "@turf-tools/db/schema";
import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";
import { activeDatasetId } from "./active-dataset";

// Custom fields (see docs/plans/custom-fields.md) — user-appended, typed,
// dataset-scoped columns that float across versions. Values live in the lake;
// this module serves the Postgres registry. `datasetId` targets any granted
// dataset (the Data page rail); omitted → the org's active dataset (the
// segment editor's filter catalog).
export const list = pub
  .input(z.object({ datasetId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const datasetId = input?.datasetId
      ? await guardDataset(context.db, context.organizationId, input.datasetId)
      : await activeDatasetId(context.db, context.organizationId);
    if (!datasetId) return [];
    const rows = await context.db
      .select({
        customFieldId: customFields.customFieldId,
        label: customFields.label,
        fieldType: customFields.fieldType,
        values: customFields.values,
        personCount: customFields.personCount,
        archivedAt: customFields.archivedAt,
      })
      .from(customFields)
      .where(eq(customFields.datasetId, datasetId))
      .orderBy(asc(customFields.label));
    return rows.map(({ archivedAt, ...f }) => ({ ...f, isArchived: archivedAt != null }));
  });

// Rename is a one-row UPDATE with no fallout: criteria and lake values are
// customFieldId-keyed — labels only exist at display edges.
export const rename = pub
  .input(z.object({ customFieldId: z.string().uuid(), label: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const field = await guardField(context.db, context.organizationId, input.customFieldId);
    const label = input.label.trim();
    if (!label) throw new ORPCError("BAD_REQUEST", { message: "Field name can't be empty." });
    const [clash] = await context.db
      .select({ customFieldId: customFields.customFieldId })
      .from(customFields)
      .where(and(eq(customFields.datasetId, field.datasetId), eq(customFields.label, label)));
    if (clash && clash.customFieldId !== input.customFieldId)
      throw new ORPCError("CONFLICT", { message: "A field with this name already exists." });
    await context.db
      .update(customFields)
      .set({ label })
      .where(eq(customFields.customFieldId, input.customFieldId));
    return { ok: true as const };
  });

// Soft-hide a field from the card / picker — display only, values untouched.
// Re-appending the label revives it.
export const archive = pub
  .input(z.object({ customFieldId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    await guardField(context.db, context.organizationId, input.customFieldId);
    await context.db
      .update(customFields)
      .set({ archivedAt: new Date() })
      .where(eq(customFields.customFieldId, input.customFieldId));
    return { ok: true as const };
  });

export const unarchive = pub
  .input(z.object({ customFieldId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    await guardField(context.db, context.organizationId, input.customFieldId);
    await context.db
      .update(customFields)
      .set({ archivedAt: null })
      .where(eq(customFields.customFieldId, input.customFieldId));
    return { ok: true as const };
  });

// Clear a field — delete its values for everyone (registry row stays at zero
// coverage, ready for re-append). Synchronous on the data side.
export const clear = pub
  .input(z.object({ customFieldId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const field = await guardField(context.db, context.organizationId, input.customFieldId);
    const [ds] = await context.db
      .select({ slug: datasets.slug })
      .from(datasets)
      .where(eq(datasets.datasetId, field.datasetId));
    if (!ds) throw new ORPCError("NOT_FOUND", { message: "Dataset not found." });
    await dataPostJson("/custom-fields/clear", {
      datasetSlug: ds.slug,
      fieldId: input.customFieldId,
    });
    return { ok: true as const };
  });

// Appends that touched a field (by label) — the field dialog's history list.
// Rows only exist for successful appends; failures never persist.
export const history = pub
  .input(z.object({ customFieldId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const field = await guardField(context.db, context.organizationId, input.customFieldId);
    return context.db
      .select({
        customFieldUploadId: customFieldUploads.customFieldUploadId,
        filename: customFieldUploads.filename,
        rowCount: customFieldUploads.rowCount,
        matchedCount: customFieldUploads.matchedCount,
        createdAt: customFieldUploads.createdAt,
      })
      .from(customFieldUploads)
      .where(
        and(
          eq(customFieldUploads.datasetId, field.datasetId),
          arrayContains(customFieldUploads.fields, [field.label]),
        ),
      )
      .orderBy(desc(customFieldUploads.createdAt));
  });

type Db = Parameters<typeof activeDatasetId>[0];

// Guards scope to datasets the org is granted — tenant isolation.
async function guardDataset(db: Db, organizationId: string, datasetId: string): Promise<string> {
  const [grant] = await db
    .select({ datasetId: datasetOrganizations.datasetId })
    .from(datasetOrganizations)
    .where(
      and(
        eq(datasetOrganizations.datasetId, datasetId),
        eq(datasetOrganizations.organizationId, organizationId),
      ),
    );
  if (!grant) throw new ORPCError("NOT_FOUND", { message: "Dataset not found." });
  return datasetId;
}

async function guardField(db: Db, organizationId: string, customFieldId: string) {
  const [row] = await db
    .select({
      customFieldId: customFields.customFieldId,
      datasetId: customFields.datasetId,
      label: customFields.label,
    })
    .from(customFields)
    .innerJoin(datasetOrganizations, eq(datasetOrganizations.datasetId, customFields.datasetId))
    .where(
      and(
        eq(customFields.customFieldId, customFieldId),
        eq(datasetOrganizations.organizationId, organizationId),
      ),
    );
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Field not found." });
  return row;
}
