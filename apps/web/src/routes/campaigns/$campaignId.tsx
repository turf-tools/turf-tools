import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Layers, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/campaigns/$campaignId")({
  component: CampaignDetail,
});

// Campaign workspace. Surfaces the campaign's metadata, the zone group +
// segment it's bound to (changeable here), and a map of its zones. Clicking
// a zone on the map drops you into the cutter for that zone.
//
// Selectors keep their picked value in local state for now — once campaigns
// reference `zoneGroupId` + `segmentId` directly, this becomes a mutation
// that persists. The pendingValueRef + onOpenChangeComplete pattern matches
// components/filter.tsx and avoids the radio-indicator flicker during the
// dropdown's close animation.
function CampaignDetail() {
  const { campaignId } = Route.useParams();
  const navigate = useNavigate();
  const { data: campaign } = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => client.campaigns.getById({ campaignId }),
  });
  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
  });
  const { data: segments } = useQuery({
    queryKey: ["segments"],
    queryFn: () => client.segments.list(),
  });

  const [activeZoneGroupId, setActiveZoneGroupId] = useState<string | null>(null);
  const [zoneGroupOpen, setZoneGroupOpen] = useState(false);
  const pendingZoneGroupRef = useRef<string | undefined>(undefined);

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const pendingSegmentRef = useRef<string | undefined>(undefined);

  // Hydrate the local selection from the campaign's saved FKs on first
  // load, then let the user override locally. A future mutation will
  // persist changes back to the campaign row.
  useEffect(() => {
    if (!activeZoneGroupId && campaign?.zoneGroupId) {
      setActiveZoneGroupId(campaign.zoneGroupId);
    }
  }, [campaign, activeZoneGroupId]);

  useEffect(() => {
    if (!activeSegmentId && campaign?.segmentId) {
      setActiveSegmentId(campaign.segmentId);
    }
  }, [campaign, activeSegmentId]);

  const activeZoneGroup = zoneGroups?.find((g) => g.zoneGroupId === activeZoneGroupId) ?? null;
  const activeSegment = segments?.find((s) => s.segmentId === activeSegmentId) ?? null;

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
        <div className="flex items-center gap-2">
          <DropdownMenu
            open={zoneGroupOpen}
            onOpenChange={setZoneGroupOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingZoneGroupRef.current !== undefined) {
                const v = pendingZoneGroupRef.current;
                pendingZoneGroupRef.current = undefined;
                setActiveZoneGroupId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <Waypoints className="size-3.5" />
              <span>{activeZoneGroup?.name ?? "—"}</span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeZoneGroupId ?? ""}
                onValueChange={(v) => {
                  pendingZoneGroupRef.current = v;
                  setZoneGroupOpen(false);
                }}
              >
                {zoneGroups?.map((g) => (
                  <DropdownMenuRadioItem key={g.zoneGroupId} value={g.zoneGroupId}>
                    {g.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu
            open={segmentOpen}
            onOpenChange={setSegmentOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingSegmentRef.current !== undefined) {
                const v = pendingSegmentRef.current;
                pendingSegmentRef.current = undefined;
                setActiveSegmentId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <Layers className="size-3.5" />
              <span>{activeSegment?.name ?? "—"}</span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeSegmentId ?? ""}
                onValueChange={(v) => {
                  pendingSegmentRef.current = v;
                  setSegmentOpen(false);
                }}
              >
                {segments?.map((s) => (
                  <DropdownMenuRadioItem key={s.segmentId} value={s.segmentId}>
                    {s.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button>Save</Button>
        </div>
      </div>

      <div className="flex h-[calc(100vh-9.75rem)] items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
        Map (zones for this campaign — click one to cut turf)
      </div>
    </>
  );
}
