import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The Lookup form's filled fields. All optional; the data server AND-matches
// whichever are non-empty (name/address prefix-match, zip/id exact).
export type PersonSearchFields = {
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  zip: string;
  externalId: string;
};

const filledKeys = (f: PersonSearchFields) =>
  Object.entries(f)
    .filter(([, v]) => v.trim().length > 0)
    .map(([k]) => k);

const anyFieldFilled = (f: PersonSearchFields) => filledKeys(f).length > 0;

// Two searches are "the same lookup" (refining a field, adding one, or paging)
// when their filled fields overlap. A search sharing no filled field — e.g. you
// cleared the name and started typing an address — is a *different* lookup.
const sameLookup = (a: PersonSearchFields, b: PersonSearchFields) => {
  const bKeys = new Set(filledKeys(b));
  return filledKeys(a).some((k) => bKeys.has(k));
};

// Paginated person search. Disabled when every field is blank. We keep the
// previous results visible only while refining/paging the *same* lookup — that
// avoids per-keystroke flicker without letting a brand-new search briefly flash
// the old results (the classic keepPreviousData-bridges-too-far bug). When the
// searches are unrelated we return `undefined`, so the panel shows a clean load
// instead of stale rows. Ambient org scoping keys it per org (see queryKeyHashFn).
export const personsSearchQuery = (fields: PersonSearchFields, limit: number, offset: number) =>
  queryOptions({
    queryKey: ["persons-search", fields, limit, offset] as const,
    queryFn: () => client.persons.search({ ...fields, limit, offset }),
    enabled: anyFieldFilled(fields),
    placeholderData: (previousData, previousQuery) => {
      if (previousData === undefined || previousQuery === undefined) return undefined;
      const previousFields = previousQuery.queryKey[1] as PersonSearchFields;
      return sameLookup(previousFields, fields) ? previousData : undefined;
    },
    staleTime: 30_000,
  });

// The full lake record for one person. Immutable per version, so cached hard;
// disabled until a person is selected.
export const personDetailQuery = (externalId: string | null) =>
  queryOptions({
    queryKey: ["person-detail", externalId] as const,
    queryFn: () => client.persons.detail({ externalId: externalId! }),
    enabled: externalId != null,
    staleTime: Number.POSITIVE_INFINITY,
  });
