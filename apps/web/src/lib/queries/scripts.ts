import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const scriptsListQuery = () =>
  queryOptions({
    queryKey: ["scripts"] as const,
    queryFn: () => client.script.list(),
  });
