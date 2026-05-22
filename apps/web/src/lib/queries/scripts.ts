import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const scriptsListQuery = () =>
  queryOptions({
    queryKey: ["scripts"] as const,
    queryFn: () => client.scripts.list(),
  });

export const scriptDetailQuery = (scriptId: string) =>
  queryOptions({
    queryKey: ["script", scriptId] as const,
    queryFn: () => client.scripts.getById({ scriptId }),
  });
