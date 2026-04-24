import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/button";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/")({
  component: ZonesIndex,
});

// Admin view for managing zones. Fields beyond id/name/created aren't
// settled yet — they'll come in once the spatial model (polygon? TIGER
// blockface set?) is nailed down alongside the turf cutter.
function ZonesIndex() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["zones"],
    queryFn: () => client.zones.list(),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Zones</h1>
      </div>
      {data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((z) => (
              <TableRow key={z.zoneId}>
                <TableCell>
                  <Pill>{z.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(z.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    aria-label="Open zone"
                    onClick={() => navigate({ to: "/zones/$zoneId", params: { zoneId: z.zoneId } })}
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
