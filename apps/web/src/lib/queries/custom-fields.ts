import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The dataset's custom fields (id + label + type + coverage). No datasetId →
// the org's active dataset (the segment editor's filter catalog); with one →
// any granted dataset (the Data page rail selection).
// Cached hard like the manifest: every writer (append / rename / archive /
// clear) invalidates the "custom-fields" prefix, so staleness can't outlive a
// mutation. Loader-prefetched on the segments path so filter cards for custom
// fields never pop in after first paint.
export const customFieldsQuery = (datasetId?: string) =>
  queryOptions({
    queryKey: ["custom-fields", datasetId ?? "active"] as const,
    queryFn: () => client.customFields.list(datasetId ? { datasetId } : undefined),
    staleTime: Number.POSITIVE_INFINITY,
  });

// A few example values from a scalar field's lake data — the field dialog's
// Examples row. Keyed under the "custom-fields" prefix so the append/clear
// invalidation refreshes it; between those, values can't change — so cache
// forever and let the fields-card hover prefetch make dialog opens instant.
export const customFieldExamplesQuery = (customFieldId: string) =>
  queryOptions({
    queryKey: ["custom-fields", "examples", customFieldId] as const,
    queryFn: () => client.customFields.examples({ customFieldId }),
    staleTime: Number.POSITIVE_INFINITY,
  });

// The dataset's base (manifest) fields, from its latest ready version — the
// Data page's fields card shows them beneath any custom fields.
export const baseFieldsQuery = (datasetId: string) =>
  queryOptions({
    queryKey: ["base-fields", datasetId] as const,
    queryFn: () => client.datasets.baseFields({ datasetId }),
    // Immutable per version; make-active invalidates globally and prefetches.
    staleTime: Number.POSITIVE_INFINITY,
  });
