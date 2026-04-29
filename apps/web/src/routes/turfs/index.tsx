import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { DoorClosed, UserRound } from "lucide-react";
import { Filter } from "~/components/filter";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { filterAtom } from "~/lib/atoms/filters";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/turfs/")({
  component: TurfsIndex,
});

// Turfs across the org, narrowed by the page-level filter (campaign for
// now, more dimensions later). A map|list toggle is planned (turfs are
// inherently geographic) but requires decisions on the map layer —
// deferred for now.
function TurfsIndex() {
  const filter = useAtomValue(filterAtom);
  const { data } = useQuery({
    queryKey: ["turfs", filter.campaignId],
    queryFn: () =>
      client.turfs.listForOrg(filter.campaignId ? { campaignId: filter.campaignId } : undefined),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Turfs</h1>
        <Filter />
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Turf</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Doors</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Zone</TableHead>
              <TableHead>Segment</TableHead>
              <TableHead>Published</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
              <TableRow key={t.turfId}>
                <TableCell>
                  <Pill>{t.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{t.turfCode ?? "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <DoorClosed className="size-3.5 text-foreground" />
                    {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <UserRound className="size-3.5 text-foreground" />
                    {t.personCount != null ? t.personCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill>{t.campaignName}</Pill>
                </TableCell>
                <TableCell>
                  <Pill>{t.zoneName ?? "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill>{t.segmentName ?? "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(t.createdAt)}</Pill>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </>
  );
}
