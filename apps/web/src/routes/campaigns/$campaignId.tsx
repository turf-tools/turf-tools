import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/button";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/$campaignId")({
  component: CampaignDetail,
});

function CampaignDetail() {
  const { campaignId } = Route.useParams();
  const navigate = useNavigate();
  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => client.campaigns.getById({ campaignId }),
  });

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate({ to: "/campaigns" })}
            aria-label="Back to campaigns"
          >
            <ArrowLeft />
          </Button>
          {campaign ? (
            <h1 className="text-xl font-extrabold tracking-wide">{campaign.name}</h1>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground">
        Metadata editor for campaign {campaignId} will live here.
      </p>
    </>
  );
}
