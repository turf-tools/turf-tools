import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The dataset's custom fields (id + label + type + coverage). No datasetId →
// the org's active dataset (the segment editor's filter catalog); with one →
// any granted dataset (the Data page rail selection).
export const customFieldsQuery = (datasetId?: string) =>
  queryOptions({
    queryKey: ["custom-fields", datasetId ?? "active"] as const,
    queryFn: () => client.customFields.list(datasetId ? { datasetId } : undefined),
  });

// Appends that touched a field — the field dialog's history list.
export const customFieldHistoryQuery = (customFieldId: string) =>
  queryOptions({
    queryKey: ["custom-field-history", customFieldId] as const,
    queryFn: () => client.customFields.history({ customFieldId }),
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
