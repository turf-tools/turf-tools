import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";

// One person hit from the Quickwit search index (the stored voter-file fields).
export type PersonHit = {
  external_id: string;
  external_id_type: string;
  first_name: string | null;
  last_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip5: string | null;
  zip4: string | null;
};

export type PersonsSearchResult = {
  numHits: number;
  hits: PersonHit[];
  offset: number;
  limit: number;
};

// One voting-history entry off the lake record (see persons_geocoded).
export type VotingHistoryEntry = { year: number; type: string; date?: string | null };

// The full lake record for one person — every column, keys are the physical
// snake_case column names (so they line up with the manifest's `column`), plus
// the parsed `votingHistory` array. Values are whatever DuckDB serialized to
// JSON, so `unknown` per column.
export type PersonDetail = Record<string, unknown> & {
  external_id: string;
  votingHistory: VotingHistoryEntry[];
};

// Structured person search (name / address / id, AND-ed) for the Lookup tab.
// Name/address prefix-match; zip/id are exact. Proxies the data service, which
// resolves the org's active version → Quickwit index.
export const search = pub
  .input(
    z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      zip: z.string().optional(),
      externalId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  )
  .handler(async ({ context, input }): Promise<PersonsSearchResult> => {
    return dataPostJson<PersonsSearchResult>("/persons/search", {
      orgSlug: context.orgSlug,
      firstName: input.firstName ?? "",
      lastName: input.lastName ?? "",
      address: input.address ?? "",
      city: input.city ?? "",
      zip: input.zip ?? "",
      externalId: input.externalId ?? "",
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    });
  });

// The full lake record for one person, by external_id — powers the Lookup
// detail pane. The search index only holds name/address; everything else
// (party, districts, voting history, …) comes from the lake.
export const detail = pub
  .input(z.object({ externalId: z.string() }))
  .handler(async ({ context, input }): Promise<{ person: PersonDetail | null }> => {
    return dataPostJson<{ person: PersonDetail | null }>("/persons/detail", {
      orgSlug: context.orgSlug,
      externalId: input.externalId,
    });
  });
