import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/button";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDate } from "~/lib/format";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/")({
  component: CampaignsIndex,
});

// Admin view for managing campaigns. Each row has an explicit Open button
// that navigates to the campaign's detail page; rows themselves aren't
// clickable. Campaigns aren't filtered by other campaigns, so no Filter here.
function CampaignsIndex() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => client.campaigns.list(),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide">Campaigns</h1>
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
            {data.map((c) => (
              <TableRow key={c.campaignId}>
                <TableCell>
                  <Pill>{c.name}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{c.startsAt ? formatDate(c.startsAt) : "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{c.endsAt ? formatDate(c.endsAt) : "—"}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{formatDate(c.createdAt)}</Pill>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    aria-label="Open campaign"
                    onClick={() =>
                      navigate({
                        to: "/campaigns/$campaignId",
                        params: { campaignId: c.campaignId },
                      })
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
