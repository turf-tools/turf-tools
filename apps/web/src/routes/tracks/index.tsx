import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/button";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/tracks/")({
  component: TracksIndex,
});

// Admin view for managing tracks. Each row has an explicit Open button
// that navigates to the track's detail page; rows themselves aren't
// clickable. Tracks aren't filtered by other tracks, so no Filter here.
function TracksIndex() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["tracks"],
    queryFn: () => client.tracks.list(),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Tracks</h1>
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
              <TableRow key={t.trackId}>
                <TableCell>
                  <Pill>{t.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{t.startsAt ? formatDate(t.startsAt) : "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{t.endsAt ? formatDate(t.endsAt) : "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(t.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    aria-label="Open track"
                    onClick={() =>
                      navigate({ to: "/tracks/$trackId", params: { trackId: t.trackId } })
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
