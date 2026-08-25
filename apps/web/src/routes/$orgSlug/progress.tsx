import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Filter } from "~/components/filter";
import { Icon } from "~/components/icon";
import { Map } from "~/components/map";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { GREEN, RED, YELLOW } from "~/lib/palette";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressByZoneQuery } from "~/lib/queries/progress";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";

// Same thresholds as the turfs board so a given percent reads as the
// same color everywhere.
function progressColor(pct: number) {
  return pct <= 25 ? RED : pct <= 75 ? YELLOW : GREEN;
}

type ProgressSearch = {
  campaign: string | null;
};

type View = "map" | "table";

export const Route = createFileRoute("/$orgSlug/progress")({
  validateSearch: (search): ProgressSearch => ({
    campaign: typeof search.campaign === "string" ? search.campaign : null,
  }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(progressByZoneQuery()),
    ]);
  },
  component: ProgressIndex,
});

function ProgressIndex() {
  const { campaign: campaignFilter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/progress");
  const [view, setView] = useState<View>("table");
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());

  const options = campaigns
    .filter((c) => !c.isArchived)
    .map((c) => ({ value: c.campaignId, label: c.name }));
  const filterLabel =
    campaignFilter === null
      ? "All campaigns"
      : (options.find((o) => o.value === campaignFilter)?.label ?? null);

  return (
    // Standalone route (no height-constrained route wrapper like data's),
    // so the viewport height lands here — without it the map's flex-1
    // container collapses to zero.
    <EditorPage className={cn("h-[calc(100vh-3.5rem)]", shouldFade)}>
      <EditorHeader title="Progress">
        <ToggleGroup
          variant="outline"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "map" || next === "table") setView(next);
          }}
        >
          <ToggleGroupItem value="map" aria-label="Map">
            <Icon name="map" className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Table">
            <Icon name="rows-3" className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Filter
          icon={<Icon name="megaphone" className="size-3.5" />}
          label={filterLabel}
          value={campaignFilter}
          options={options}
          allLabel="All campaigns"
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, campaign: next }) })}
        />
      </EditorHeader>
      {view === "map" ? (
        <div className="relative min-h-0 flex-1">
          {/* Blank basemap for now; will show zones colored by progress. */}
          <Map className="h-full" />
        </div>
      ) : (
        <ProgressTable campaignFilter={campaignFilter} />
      )}
    </EditorPage>
  );
}

function ProgressTable({ campaignFilter }: { campaignFilter: string | null }) {
  const { data } = useSuspenseQuery(progressByZoneQuery());
  const rows = campaignFilter ? data.filter((r) => r.campaignId === campaignFilter) : data;

  return (
    <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          {/* 60/40 split of the flexible space between the two name
              columns — zone names run longer than campaign names.
              Campaign sits far right like on the turfs board. */}
          <TableHead className="w-[36%]">Zone</TableHead>
          <TableHead className="w-28">People</TableHead>
          <TableHead className="w-28">Doors</TableHead>
          <TableHead className="w-20">Turfs</TableHead>
          <TableHead className="w-20">Used</TableHead>
          <TableHead className="w-26">Remaining</TableHead>
          <TableHead className="w-24">Progress</TableHead>
          <TableHead className="w-[24%]">Campaign</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={8}>
              <Pill>
                <span>No results</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => {
            const pct = r.people > 0 ? Math.round((100 * r.attempted) / r.people) : null;
            return (
              <TableRow key={`${r.campaignId}:${r.zoneId ?? "none"}`}>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{r.zoneName ?? "—"}</span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <Icon name="user-round" className="size-3.5 shrink-0 text-foreground" />
                    {r.people.toLocaleString()}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <Icon name="door-closed" className="size-3.5 shrink-0 text-foreground" />
                    {r.doors.toLocaleString()}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{r.turfs.toLocaleString()}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{r.used.toLocaleString()}</Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">{(r.turfs - r.used).toLocaleString()}</Pill>
                </TableCell>
                <TableCell>
                  <Pill
                    variant="number"
                    color={pct !== null && pct > 0 ? progressColor(pct) : undefined}
                  >
                    {pct !== null ? `${pct}%` : null}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{r.campaignName}</span>
                  </Pill>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
