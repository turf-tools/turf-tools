import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Scissors } from "lucide-react";
import { Button } from "~/components/button";
import { Filter } from "~/components/filter";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { listFilterAtom } from "~/lib/atoms/filters";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/lists/")({
  component: ListsIndex,
});

function ListsIndex() {
  const filter = useAtomValue(listFilterAtom);
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["lists", filter.trackId],
    queryFn: () => client.lists.list(filter.trackId ? { trackId: filter.trackId } : undefined),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Lists</h1>
        <Filter />
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Doors</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Voter file</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0" />
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((l) => (
              <TableRow key={l.listId}>
                <TableCell>
                  <Pill>{l.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {l.doorCount != null ? l.doorCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {l.personCount != null ? l.personCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill>
                    {l.voterFileId ?? "—"}
                    {l.voterFileVersion ? ` v${l.voterFileVersion}` : ""}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(l.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      navigate({ to: "/lists/$listId/cut", params: { listId: l.listId } })
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
                    aria-label="Open list"
                    onClick={() => navigate({ to: "/lists/$listId", params: { listId: l.listId } })}
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
