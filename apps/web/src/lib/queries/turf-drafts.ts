import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// `zoneId: null` is the zoneless scope (cut against the full segment).
// The cache key keeps `null` as a discrete bucket so zoned and zoneless
// drafts on the same campaign don't share state.
export const turfDraftsQuery = (campaignId: string, zoneId: string | null) =>
  queryOptions({
    queryKey: ["turf-drafts", campaignId, zoneId] as const,
    queryFn: () => client.turfDrafts.list({ campaignId, zoneId }),
  });
