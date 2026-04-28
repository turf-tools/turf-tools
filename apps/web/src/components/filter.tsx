import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { ChevronDown, Megaphone } from "lucide-react";
import { useEffect, useState } from "react";
import { filterAtom } from "~/lib/atoms/filters";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { client } from "~/rpc/client";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// Filter controls for the top-level admin index pages (/segments, /turfs).
// Currently one campaign filter; more dimensions (tags, status, etc.) plug
// in alongside by adding controls here and expanding filterAtom. Text size
// is pinned to `text-sm` so it matches the breadcrumb, sidebar, and table —
// we want deliberate size variation, not one-off slightly-smaller chrome.
const ALL_CAMPAIGNS = "__all__";

export function Filter() {
  const [filter, setFilter] = useAtom(filterAtom);
  const dd = useDeferredRadioDropdown({
    onCommit: (v) => setFilter({ ...filter, campaignId: v === ALL_CAMPAIGNS ? null : v }),
  });
  // Mount gate: server renders with the default atom value (campaignId=null),
  // but the client has `getOnInit: true` so it reads the persisted value
  // synchronously — those diverge and React throws a hydration mismatch.
  // Pin the first client render to the server output, then flip to real
  // state after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: campaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => client.campaigns.list(),
    placeholderData: keepPreviousData,
  });

  const selectedCampaign = campaigns?.find((c) => c.campaignId === filter.campaignId);
  const campaignLabel = mounted ? (selectedCampaign?.name ?? "All campaigns") : "All campaigns";
  // After mount, if a campaign is persisted but the campaigns query hasn't
  // resolved yet, `selectedCampaign` is undefined and the label falls back to
  // "All campaigns" — wrong. Hide the label until lookup completes so we
  // jump straight from blank to the real name instead of flashing the
  // unfiltered label.
  const isResolving = mounted && filter.campaignId !== null && !selectedCampaign;

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu {...dd.menu}>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          <Megaphone className="size-3.5" />
          <span className={isResolving ? "invisible" : undefined}>{campaignLabel}</span>
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuRadioGroup {...dd.radio} value={filter.campaignId ?? ALL_CAMPAIGNS}>
            <DropdownMenuRadioItem value={ALL_CAMPAIGNS}>All campaigns</DropdownMenuRadioItem>
            {campaigns?.map((c) => (
              <DropdownMenuRadioItem key={c.campaignId} value={c.campaignId}>
                {c.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
