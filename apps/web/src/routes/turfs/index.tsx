import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/button";
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
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["turfs", filter.campaignId],
    queryFn: () =>
      client.turfs.listForOrg(filter.campaignId ? { campaignId: filter.campaignId } : undefined),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Turfs</h1>
        <Filter />
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Segment</TableHead>
              <TableHead>Doors</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0" />
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
                  <Pill>{t.campaignName}</Pill>
                </TableCell>
                <TableCell>
                  <Pill>{t.segmentName}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {t.personCount != null ? t.personCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  {t.assignedTo ? <Pill variant="blue">assigned</Pill> : <Pill>unassigned</Pill>}
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(t.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    aria-label="Open turf"
                    onClick={() => navigate({ to: "/turfs/$turfId", params: { turfId: t.turfId } })}
                  >
                    <ArrowUpRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </>
  );
}
