import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The registered importers. Changes only on a data-server deploy.
export const importersQuery = () =>
  queryOptions({
    queryKey: ["importers"] as const,
    queryFn: () => client.importers.list(),
    staleTime: Infinity,
  });
