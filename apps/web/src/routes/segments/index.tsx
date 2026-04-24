import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Scissors } from "lucide-react";
import { Button } from "~/components/button";
import { Filter } from "~/components/filter";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { filterAtom } from "~/lib/atoms/filters";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/segments/")({
  component: SegmentsIndex,
});

function SegmentsIndex() {
  const filter = useAtomValue(filterAtom);
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["segments", filter.campaignId],
    queryFn: () =>
      client.segments.list(filter.campaignId ? { campaignId: filter.campaignId } : undefined),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Segments</h1>
        <Filter />
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Doors</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Voter file</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0" />
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((s) => (
              <TableRow key={s.segmentId}>
                <TableCell>
                  <Pill>{s.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill>{s.campaignName}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {s.doorCount != null ? s.doorCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {s.personCount != null ? s.personCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill>
                    {s.voterFileId ?? "—"}
                    {s.voterFileVersion ? ` v${s.voterFileVersion}` : ""}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(s.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      navigate({
                        to: "/segments/$segmentId/cut",
                        params: { segmentId: s.segmentId },
                      })
                    }
                  >
                    <Scissors />
                    Cut turf
                  </Button>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    aria-label="Open segment"
                    onClick={() =>
                      navigate({ to: "/segments/$segmentId", params: { segmentId: s.segmentId } })
                    }
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
