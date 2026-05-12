import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DoorClosed, Megaphone, UserRound } from "lucide-react";
import { Suspense, useMemo } from "react";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDate } from "~/lib/format";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { turfsListQuery } from "~/lib/queries/turfs";
import { useFadeOnce } from "~/lib/use-fade-once";

type TurfsSearch = {
  campaignId: string | null;
};

export const Route = createFileRoute("/turfs/")({
  validateSearch: (search): TurfsSearch => ({
    campaignId: typeof search.campaignId === "string" ? search.campaignId : null,
  }),
  loaderDeps: ({ search }) => ({ campaignId: search.campaignId }),
  loader: ({ context: { queryClient }, deps }) =>
    Promise.all([
      queryClient.fetchQuery(turfsListQuery(deps.campaignId)),
      queryClient.fetchQuery(campaignsListQuery()),
    ]),
  component: TurfsIndex,
});

function TurfsIndex() {
  const { campaignId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/turfs");

  const { data: campaigns } = useQuery(campaignsListQuery());

  const onCampaignIdChange = (next: string | null) => {
    void navigate({
      search: (prev) => ({ ...prev, campaignId: next }),
    });
  };

  const campaignLabel =
    campaignId === null
      ? "All campaigns"
      : (campaigns?.find((c) => c.campaignId === campaignId)?.name ?? null);
  const campaignOptions = campaigns?.map((c) => ({ value: c.campaignId, label: c.name })) ?? [];

  return (
    <Page className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
      <EditorHeader title="Turfs">
        <Filter
          icon={<Megaphone className="size-3.5" />}
          label={campaignLabel}
          value={campaignId}
          options={campaignOptions}
          allLabel="All campaigns"
          onChange={onCampaignIdChange}
        />
      </EditorHeader>
      <Suspense fallback={null}>
        <TurfsTable campaignId={campaignId} />
      </Suspense>
    </Page>
  );
}

function TurfsTable({ campaignId }: { campaignId: string | null }) {
  const { data } = useSuspenseQuery(turfsListQuery(campaignId));
  // Bulk publish writes all rows in a single statement, so they share a
  // created_at; name (natural-numeric) breaks the tie so "Turf 2" stays
  // ahead of "Turf 10" within a single publish batch.
  const rows = useMemo(
    () =>
      [...data].sort((a, b) => {
        const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (t !== 0) return t;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }),
    [data],
  );

  return (
    <Table containerClassName="h-[calc(100vh-9rem)] overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className="w-20">Turf</TableHead>
          <TableHead className="w-26">Code</TableHead>
          <TableHead className="w-24">Doors</TableHead>
          <TableHead className="w-24">People</TableHead>
          <TableHead className="">Campaign</TableHead>
          <TableHead className="">Zone</TableHead>
          <TableHead className="">Segment</TableHead>
          <TableHead className="w-26">Published</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8}>
              <Pill>No results</Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((t) => (
          <TableRow key={t.turfId}>
            <TableCell>
              <Pill>{t.name}</Pill>
            </TableCell>
            <TableCell>
              <Pill variant="number">{t.turfCode ?? "—"}</Pill>
            </TableCell>
            <TableCell>
              <Pill variant="number" className="gap-1.5">
                <DoorClosed className="size-3.5 text-foreground" />
                {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
              </Pill>
            </TableCell>
            <TableCell>
              <Pill variant="number" className="gap-1.5">
                <UserRound className="size-3.5 text-foreground" />
                {t.personCount != null ? t.personCount.toLocaleString() : "—"}
              </Pill>
            </TableCell>
            <TableCell>
              <Pill className="min-w-0">
                <span className="truncate">{t.campaignName}</span>
              </Pill>
            </TableCell>
            <TableCell>
              <Pill className="min-w-0">
                <span className="truncate">{t.zoneName ?? "—"}</span>
              </Pill>
            </TableCell>
            <TableCell>
              <Pill className="min-w-0">
                <span className="truncate">{t.segmentName ?? "—"}</span>
              </Pill>
            </TableCell>
            <TableCell>
              <Pill variant="number">{formatDate(t.createdAt)}</Pill>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
