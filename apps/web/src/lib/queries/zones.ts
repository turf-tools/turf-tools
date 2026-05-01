import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const zoneGroupsQuery = () =>
  queryOptions({
    queryKey: ["zone-groups"] as const,
    queryFn: () => client.zoneGroups.list(),
  });

export const zonesQuery = (zoneGroupId: string) =>
  queryOptions({
    queryKey: ["zones", zoneGroupId] as const,
    queryFn: () => client.zones.list({ zoneGroupId }),
  });
