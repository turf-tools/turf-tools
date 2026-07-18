import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The org's datasets + active-version status. Refetched on the default cadence
// so an in-progress import's status advances without a manual reload.
export const datasetsListQuery = () =>
  queryOptions({
    queryKey: ["datasets"] as const,
    queryFn: () => client.datasets.list(),
  });
