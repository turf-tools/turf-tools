import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const usersListQuery = () =>
  queryOptions({
    queryKey: ["users"] as const,
    queryFn: () => client.users.list(),
  });
