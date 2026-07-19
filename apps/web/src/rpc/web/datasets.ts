import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq } from "@turf-tools/db";
import {
  datasetOrganizations,
  datasets,
  datasetVersions,
  jobs,
  organizations,
} from "@turf-tools/db/schema";
import { z } from "zod";
import { AVAILABLE_IMPORTERS } from "~/lib/importers";
import type { Manifest } from "~/lib/manifest";
import { webPub as pub } from "../context";

// Machine identity from the display name — becomes the DuckLake schema prefix
// (`<slug>_v<n>`). Lowercase alphanumeric + underscores.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Every version the org can see, as flat rows (dataset identity + version),
// newest first within each dataset. `isActive` marks the single version the org
// is currently working against (`organizations.activeDatasetVersionId`).
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const [org] = await context.db
    .select({ activeDatasetVersionId: organizations.activeDatasetVersionId })
    .from(organizations)
    .where(eq(organizations.organizationId, context.organizationId));
  const activeDatasetVersionId = org?.activeDatasetVersionId ?? null;

  const rows = await context.db
    .select({
      datasetId: datasets.datasetId,
      name: datasets.name,
      slug: datasets.slug,
      importer: datasets.importer,
      versionId: datasetVersions.datasetVersionId,
      versionNumber: datasetVersions.versionNumber,
      status: datasetVersions.status,
      rowCount: datasetVersions.rowCount,
      importedAt: datasetVersions.createdAt,
      archivedAt: datasetVersions.archivedAt,
      importStep: datasetVersions.importStep,
      importTotalSteps: datasetVersions.importTotalSteps,
    })
    .from(datasetOrganizations)
    .innerJoin(datasets, eq(datasets.datasetId, datasetOrganizations.datasetId))
    .innerJoin(datasetVersions, eq(datasetVersions.datasetId, datasets.datasetId))
    .where(eq(datasetOrganizations.organizationId, context.organizationId))
    .orderBy(asc(datasets.name), desc(datasetVersions.versionNumber));

  return rows.map((r) => ({
    ...r,
    isActive: r.versionId === activeDatasetVersionId,
    isArchived: r.archivedAt != null,
  }));
});

// Promote a version to the org's active one — the "Make active" action. Only a
// `ready` version the org is granted can be activated.
export const makeActive = pub
  .input(z.object({ versionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const [v] = await context.db
      .select({ status: datasetVersions.status, archivedAt: datasetVersions.archivedAt })
      .from(datasetVersions)
      .innerJoin(
        datasetOrganizations,
        eq(datasetOrganizations.datasetId, datasetVersions.datasetId),
      )
      .where(
        and(
          eq(datasetVersions.datasetVersionId, input.versionId),
          eq(datasetOrganizations.organizationId, context.organizationId),
        ),
      )
      .limit(1);
    if (!v) throw new ORPCError("NOT_FOUND", { message: "Version not found." });
    if (v.status !== "ready")
      throw new ORPCError("BAD_REQUEST", { message: "Only a ready version can be made active." });
    if (v.archivedAt)
      throw new ORPCError("BAD_REQUEST", {
        message: "Unarchive this version before making it active.",
      });

    await context.db
      .update(organizations)
      .set({ activeDatasetVersionId: input.versionId })
      .where(eq(organizations.organizationId, context.organizationId));
    return { ok: true };
  });

// Archive a version — soft-hides it from the default Data list. Allowed on any
// granted `ready`/`failed` version except the org's active one (switch away
// first) and never while it's still importing.
export const archive = pub
  .input(z.object({ versionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const [org] = await context.db
      .select({ activeDatasetVersionId: organizations.activeDatasetVersionId })
      .from(organizations)
      .where(eq(organizations.organizationId, context.organizationId));
    if (org?.activeDatasetVersionId === input.versionId)
      throw new ORPCError("BAD_REQUEST", {
        message: "Can't archive the active version — make another version active first.",
      });

    const [v] = await context.db
      .select({ status: datasetVersions.status })
      .from(datasetVersions)
      .innerJoin(
        datasetOrganizations,
        eq(datasetOrganizations.datasetId, datasetVersions.datasetId),
      )
      .where(
        and(
          eq(datasetVersions.datasetVersionId, input.versionId),
          eq(datasetOrganizations.organizationId, context.organizationId),
        ),
      )
      .limit(1);
    if (!v) throw new ORPCError("NOT_FOUND", { message: "Version not found." });
    if (v.status === "importing")
      throw new ORPCError("BAD_REQUEST", { message: "Can't archive an in-progress import." });

    await context.db
      .update(datasetVersions)
      .set({ archivedAt: new Date() })
      .where(eq(datasetVersions.datasetVersionId, input.versionId));
    return { ok: true };
  });

// Restore an archived version to the default list.
export const unarchive = pub
  .input(z.object({ versionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const [v] = await context.db
      .select({ id: datasetVersions.datasetVersionId })
      .from(datasetVersions)
      .innerJoin(
        datasetOrganizations,
        eq(datasetOrganizations.datasetId, datasetVersions.datasetId),
      )
      .where(
        and(
          eq(datasetVersions.datasetVersionId, input.versionId),
          eq(datasetOrganizations.organizationId, context.organizationId),
        ),
      )
      .limit(1);
    if (!v) throw new ORPCError("NOT_FOUND", { message: "Version not found." });

    await context.db
      .update(datasetVersions)
      .set({ archivedAt: null })
      .where(eq(datasetVersions.datasetVersionId, input.versionId));
    return { ok: true };
  });

// Create a dataset (identity: name + importer + derived slug), grant it to the
// org, and open its first version as `importing`. The geocode job lands the
// manifest + marks it `ready`; the user then promotes it via "Make active".
// Nothing is disrupted meanwhile — the org keeps running on its current version.
export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      importer: z.enum(AVAILABLE_IMPORTERS.map((i) => i.name) as [string, ...string[]]),
      sourceUri: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const slug = slugify(input.name);
    if (!slug)
      throw new ORPCError("BAD_REQUEST", { message: "Name must contain letters or numbers." });

    const clash = await context.db
      .select({ id: datasets.datasetId })
      .from(datasets)
      .where(eq(datasets.slug, slug))
      .limit(1);
    if (clash.length > 0)
      throw new ORPCError("CONFLICT", {
        message:
          "A dataset with this name already exists. If you are trying to update an existing dataset, use “Update” on its row to import a newer version.",
      });

    return context.db.transaction(async (tx) => {
      const [ds] = await tx
        .insert(datasets)
        .values({ slug, name: input.name, importer: input.importer })
        .returning({ datasetId: datasets.datasetId });
      await tx
        .insert(datasetOrganizations)
        .values({ datasetId: ds!.datasetId, organizationId: context.organizationId });
      const [version] = await tx
        .insert(datasetVersions)
        .values({
          datasetId: ds!.datasetId,
          versionNumber: 1,
          status: "importing",
          sourceUri: input.sourceUri,
          createdBy: context.user.id,
        })
        .returning({ datasetVersionId: datasetVersions.datasetVersionId });
      // Enqueue the geocode job — the data-server worker picks it up, runs the
      // importer + DAG, and marks the version `ready`.
      await tx.insert(jobs).values({
        task: "import_dataset_version",
        payload: { dataset_version_id: version!.datasetVersionId, source: input.sourceUri },
      });
      return { datasetId: ds!.datasetId };
    });
  });

// Import a newer version into an existing dataset (the "Update" action). Adds
// v(n+1) as `importing` and enqueues the geocode job; the org keeps running on
// its current active version until the new one is Ready and explicitly made
// active. Blocks a second concurrent import on the same dataset.
export const update = pub
  .input(z.object({ datasetId: z.string().uuid(), sourceUri: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    return context.db.transaction(async (tx) => {
      // Must be a dataset the org is granted.
      const [grant] = await tx
        .select({ datasetId: datasets.datasetId })
        .from(datasets)
        .innerJoin(datasetOrganizations, eq(datasetOrganizations.datasetId, datasets.datasetId))
        .where(
          and(
            eq(datasets.datasetId, input.datasetId),
            eq(datasetOrganizations.organizationId, context.organizationId),
          ),
        )
        .limit(1);
      if (!grant) throw new ORPCError("NOT_FOUND", { message: "Dataset not found." });

      const versions = await tx
        .select({ versionNumber: datasetVersions.versionNumber, status: datasetVersions.status })
        .from(datasetVersions)
        .where(eq(datasetVersions.datasetId, input.datasetId))
        .orderBy(desc(datasetVersions.versionNumber));
      if (versions.some((v) => v.status === "importing"))
        throw new ORPCError("CONFLICT", {
          message: "An import is already in progress for this dataset. Wait for it to finish.",
        });
      // The unique (dataset_id, version_number) index makes a concurrent double-
      // update fail on insert rather than mint a duplicate number.
      const nextNumber = (versions[0]?.versionNumber ?? 0) + 1;

      const [version] = await tx
        .insert(datasetVersions)
        .values({
          datasetId: input.datasetId,
          versionNumber: nextNumber,
          status: "importing",
          sourceUri: input.sourceUri,
          createdBy: context.user.id,
        })
        .returning({ datasetVersionId: datasetVersions.datasetVersionId });
      await tx.insert(jobs).values({
        task: "import_dataset_version",
        payload: { dataset_version_id: version!.datasetVersionId, source: input.sourceUri },
      });
      return { versionId: version!.datasetVersionId };
    });
  });

// The manifest of the org's active version — the field catalog the segment and
// zone editors render from. Follows `organizations.activeDatasetVersionId`. Immutable
// per version, so the client caches it hard. Null when nothing is active yet.
export const manifest = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      manifest: datasetVersions.manifest,
      versionId: datasetVersions.datasetVersionId,
    })
    .from(organizations)
    .innerJoin(
      datasetVersions,
      eq(datasetVersions.datasetVersionId, organizations.activeDatasetVersionId),
    )
    .where(eq(organizations.organizationId, context.organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { manifest: row.manifest as Manifest, versionId: row.versionId };
});
