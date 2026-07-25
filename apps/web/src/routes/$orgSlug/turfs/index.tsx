import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  DoorClosed,
  LayoutGrid,
  Megaphone,
  QrCode,
  Rows3,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/button";
import { Dialog, DialogContent } from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { formatDate, formatTime } from "~/lib/format";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { turfsListQuery } from "~/lib/queries/turfs";
import { walksListQuery } from "~/lib/queries/walks";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { cn } from "~/lib/utils";
import { useFadeOnce } from "~/lib/use-fade-once";
import { client } from "~/rpc/client";

type TurfsSearch = {
  campaignId: string | null;
  zoneId: string | null;
};

type TurfRow = Awaited<ReturnType<typeof client.turfs.listForOrg>>[number];
type WalkRow = Awaited<ReturnType<typeof client.walks.listForOrg>>[number];

const OUT_COLOR = "#3ca951";

export const Route = createFileRoute("/$orgSlug/turfs/")({
  validateSearch: (search): TurfsSearch => ({
    campaignId: typeof search.campaignId === "string" ? search.campaignId : null,
    zoneId: typeof search.zoneId === "string" ? search.zoneId : null,
  }),
  loaderDeps: ({ search }) => ({ campaignId: search.campaignId }),
  loader: ({ context: { queryClient }, deps }) =>
    Promise.all([
      queryClient.fetchQuery(turfsListQuery(deps.campaignId)),
      queryClient.fetchQuery(walksListQuery(deps.campaignId)),
      queryClient.fetchQuery(campaignsListQuery()),
    ]),
  component: TurfsIndex,
});

function TurfsIndex() {
  const { campaignId, zoneId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/turfs");

  const { data: campaigns } = useQuery(campaignsListQuery());
  const { data: turfs } = useSuspenseQuery(turfsListQuery(campaignId));

  // Mobile-only rendering choice; desktop is always the table.
  const [view, setView] = useState<"cards" | "table">("cards");

  // QR dialog: open flag and turf snapshot split so the dialog body
  // doesn't flash empty during the close animation.
  const [qrTurf, setQrTurf] = useState<TurfRow | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const showQr = (turf: TurfRow) => {
    setQrTurf(turf);
    setQrOpen(true);
  };

  const onSearchChange = (patch: Partial<TurfsSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  const campaignLabel =
    campaignId === null
      ? "All campaigns"
      : (campaigns?.find((c) => c.campaignId === campaignId)?.name ?? null);
  const campaignOptions = campaigns?.map((c) => ({ value: c.campaignId, label: c.name })) ?? [];

  // Zone options come from the turfs in view (already campaign-scoped), so
  // the filter never offers a zone with nothing behind it.
  const zoneOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of turfs) {
      if (t.zoneId && t.zoneName && !seen.has(t.zoneId)) seen.set(t.zoneId, t.zoneName);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [turfs]);
  const zoneLabel =
    zoneId === null ? "All zones" : (zoneOptions.find((z) => z.value === zoneId)?.label ?? null);

  return (
    <Page className={shouldFade}>
      <EditorHeader title="Turfs">
        <ToggleGroup
          variant="outline"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "cards" || next === "table") setView(next);
          }}
          className="md:hidden"
        >
          <ToggleGroupItem value="cards" aria-label="Cards">
            <LayoutGrid className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Table">
            <Rows3 className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Filter
          icon={<Megaphone className="size-3.5" />}
          label={campaignLabel}
          value={campaignId}
          options={campaignOptions}
          allLabel="All campaigns"
          onChange={(next) => onSearchChange({ campaignId: next, zoneId: null })}
        />
        <Filter
          icon={<Waypoints className="size-3.5" />}
          label={zoneLabel}
          value={zoneId}
          options={zoneOptions}
          allLabel="All zones"
          onChange={(next) => onSearchChange({ zoneId: next })}
        />
      </EditorHeader>
      <div className="md:hidden">
        {view === "cards" ? (
          <TurfCards campaignId={campaignId} zoneId={zoneId} onShowQr={showQr} />
        ) : (
          <TurfsTable campaignId={campaignId} zoneId={zoneId} onShowQr={showQr} compact />
        )}
      </div>
      <div className="hidden md:block">
        <TurfsTable campaignId={campaignId} zoneId={zoneId} onShowQr={showQr} />
      </div>
      <QrDialog turf={qrTurf} open={qrOpen} onOpenChange={setQrOpen} />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

function useTurfRows(campaignId: string | null, zoneId: string | null) {
  const { data } = useSuspenseQuery(turfsListQuery(campaignId));
  // Bulk publish writes all rows in a single statement, so they share a
  // created_at; name (natural-numeric) breaks the tie so "Turf 2" stays
  // ahead of "Turf 10" within a single publish batch.
  return useMemo(
    () =>
      data
        .filter((t) => zoneId === null || t.zoneId === zoneId)
        .sort((a, b) => {
          const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          if (t !== 0) return t;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        }),
    [data, zoneId],
  );
}

function useWalksByTurf(campaignId: string | null) {
  const { data } = useQuery(walksListQuery(campaignId));
  return useMemo(() => {
    const byTurf = new Map<string, WalkRow[]>();
    for (const w of data ?? []) {
      const list = byTurf.get(w.turfId);
      if (list) list.push(w);
      else byTurf.set(w.turfId, [w]);
    }
    return byTurf;
  }, [data]);
}

const activeWalks = (walks: WalkRow[]) => walks.filter((w) => !w.closedAt);

// "Jane" / "Jane +1" — first name out plus how many more.
function outLabel(active: WalkRow[]) {
  const first = active[0]!.canvasserName;
  return active.length > 1 ? `${first} +${active.length - 1}` : first;
}

function useClearWalk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (walkId: string) => client.walks.clear({ walkId }),
    onError: (e) => toast.error(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["walks"] }),
  });
}

// ---------------------------------------------------------------------------
// QR dialog
// ---------------------------------------------------------------------------

// The payload matches the native scanner's expected format (see
// parseTurfQr): a real URL so a system-camera scan can someday land on a
// web page, with `/t/` as the format discriminator.
function qrValue(code: string) {
  return `${window.location.origin}/t/${code}`;
}

function QrDialog({
  turf,
  open,
  onOpenChange,
}: {
  turf: TurfRow | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {turf?.turfCode ? (
          <div className="flex flex-col items-center gap-4 pt-2">
            {/* Always-white plate so the code scans in dark mode. */}
            <div className="w-full rounded-lg bg-white p-4">
              <QRCodeSVG
                value={qrValue(turf.turfCode)}
                size={512}
                marginSize={0}
                className="h-auto w-full"
              />
            </div>
            <span className="font-mono text-3xl tracking-widest tabular-nums">{turf.turfCode}</span>
            <span className="text-sm text-muted-foreground">
              {turf.name}
              {turf.zoneName ? ` — ${turf.zoneName}` : ""}
            </span>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Indicators (shared between table cells and cards)
// ---------------------------------------------------------------------------

// Ever-walked: check + most recent open date. Distinct from "out now" —
// "walked Tuesday, nobody out there" and "Jane's out right now" are
// different facts and both matter at a launch table.
function WalkedPill({ walks, tz }: { walks: WalkRow[]; tz: string }) {
  if (walks.length === 0) return <Pill variant="number">—</Pill>;
  const last = walks[walks.length - 1]!;
  return (
    <Pill variant="number" className="gap-1.5">
      <Check className="size-3.5 text-foreground" />
      {formatDate(last.openedAt, tz)}
    </Pill>
  );
}

function OutPill({ active }: { active: WalkRow[] }) {
  if (active.length === 0) return <Pill>—</Pill>;
  return (
    <Pill className="min-w-0" style={{ backgroundColor: `${OUT_COLOR}20`, color: OUT_COLOR }}>
      <span className="truncate">{outLabel(active)}</span>
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Walk history (expanded card section)
// ---------------------------------------------------------------------------

function WalkHistory({ walks, tz }: { walks: WalkRow[]; tz: string }) {
  const clearWalk = useClearWalk();
  return (
    <div>
      {[...walks].reverse().map((w) => (
        <div key={w.walkId} className="flex h-10 items-center gap-2 border-t border-border px-3">
          {w.closedAt ? null : (
            <span className="size-2 rounded-full" style={{ backgroundColor: OUT_COLOR }} />
          )}
          <span className="truncate text-sm">{w.canvasserName}</span>
          {/* Open–close range: a "10:15 – 10:16" walk reads as the no-op
              it was, without encoding any duration heuristic. */}
          <span className="ml-auto font-mono text-sm text-muted-foreground tabular-nums">
            {formatDate(w.openedAt, tz)} {formatTime(w.openedAt, tz)}
            {w.closedAt ? ` – ${formatTime(w.closedAt, tz)}` : ""}
          </span>
          {w.closedAt ? null : (
            <Button
              variant="ghost"
              className="h-7 px-2 text-muted-foreground"
              onClick={() => clearWalk.mutate(w.walkId)}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {walks.length === 0 ? (
        <div className="flex h-10 items-center border-t border-border px-3 text-sm text-muted-foreground">
          No walks yet
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards (mobile)
// ---------------------------------------------------------------------------

function TurfCards({
  campaignId,
  zoneId,
  onShowQr,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
}) {
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const rows = useTurfRows(campaignId, zoneId);
  const walksByTurf = useWalksByTurf(campaignId);

  if (rows.length === 0) {
    return (
      <Pill>
        <span>No results</span>
      </Pill>
    );
  }
  return (
    <div className="flex flex-col gap-3 pb-8">
      {rows.map((t) => (
        <TurfCard
          key={t.turfId}
          turf={t}
          walks={walksByTurf.get(t.turfId) ?? []}
          tz={tz}
          onShowQr={onShowQr}
        />
      ))}
    </div>
  );
}

function TurfCard({
  turf,
  walks,
  tz,
  onShowQr,
}: {
  turf: TurfRow;
  walks: WalkRow[];
  tz: string;
  onShowQr: (turf: TurfRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = activeWalks(walks);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 p-3">
        <span className="text-sm font-extrabold">{turf.name}</span>
        {walks.length > 0 && active.length === 0 ? (
          <span
            className={cn(
              "flex h-6 items-center gap-1 rounded-md bg-muted px-1.5",
              "text-sm text-muted-foreground",
            )}
          >
            <Check className="size-3.5 [stroke-width:2.5]" />
          </span>
        ) : null}
        {active.length > 0 ? (
          <span
            className="flex h-6 items-center rounded-md px-2 text-sm font-medium"
            style={{ backgroundColor: `${OUT_COLOR}22`, color: OUT_COLOR }}
          >
            {outLabel(active)}
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto flex items-center gap-2.5",
            "font-mono text-sm text-muted-foreground tabular-nums",
          )}
        >
          <span className="flex items-center gap-1">
            <DoorClosed className="size-3.5" />
            {turf.doorCount != null ? turf.doorCount.toLocaleString() : "—"}
          </span>
          <span className="flex items-center gap-1">
            <UserRound className="size-3.5" />
            {turf.personCount != null ? turf.personCount.toLocaleString() : "—"}
          </span>
        </span>
      </div>
      <div className="flex items-center justify-between px-3 pb-3">
        <Button
          variant="outline"
          disabled={!turf.turfCode || turf.status !== "active"}
          onClick={() => onShowQr(turf)}
        >
          <QrCode className="size-3.5" />
          <span className="font-mono tabular-nums">{turf.turfCode ?? "—"}</span>
        </Button>
        <Button variant="ghost" aria-label="History" onClick={() => setExpanded((prev) => !prev)}>
          <ChevronDown
            className={cn("size-4 transition-transform duration-150", expanded && "rotate-180")}
          />
        </Button>
      </div>
      {expanded ? <WalkHistory walks={walks} tz={tz} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table (desktop always; mobile behind the toggle, compact)
// ---------------------------------------------------------------------------

function TurfsTable({
  campaignId,
  zoneId,
  onShowQr,
  compact = false,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  // Mobile rendering: only the launch-table columns, like the legacy
  // app's phone table (it dropped context columns on narrow screens).
  compact?: boolean;
}) {
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const rows = useTurfRows(campaignId, zoneId);
  const walksByTurf = useWalksByTurf(campaignId);
  const colSpan = compact ? 4 : 10;

  return (
    <Table containerClassName="h-[calc(100vh-9rem)] overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className={compact ? "w-16" : "w-20"}>Turf</TableHead>
          <TableHead className="w-26">Code</TableHead>
          {compact ? null : <TableHead className="w-24">Doors</TableHead>}
          {compact ? null : <TableHead className="w-24">People</TableHead>}
          <TableHead className={compact ? "w-24" : "w-28"}>Walked</TableHead>
          <TableHead className="">Out</TableHead>
          {compact ? null : <TableHead className="">Campaign</TableHead>}
          {compact ? null : <TableHead className="">Zone</TableHead>}
          {compact ? null : <TableHead className="">Segment</TableHead>}
          {compact ? null : <TableHead className="w-26">Published</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={colSpan}>
              <Pill>
                <span>No results</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((t) => {
          const walks = walksByTurf.get(t.turfId) ?? [];
          return (
            <TableRow key={t.turfId}>
              <TableCell>
                <Pill>{t.name}</Pill>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  className="w-full"
                  disabled={!t.turfCode || t.status !== "active"}
                  onClick={() => onShowQr(t)}
                >
                  <Pill
                    variant="number"
                    className={cn(
                      "gap-1.5",
                      t.turfCode && t.status === "active" && "cursor-pointer hover:bg-accent",
                    )}
                  >
                    {t.turfCode ? <QrCode className="size-3.5 text-foreground" /> : null}
                    {t.turfCode ?? "—"}
                  </Pill>
                </button>
              </TableCell>
              {compact ? null : (
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <DoorClosed className="size-3.5 text-foreground" />
                    {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
              )}
              {compact ? null : (
                <TableCell>
                  <Pill variant="number" className="gap-1.5">
                    <UserRound className="size-3.5 text-foreground" />
                    {t.personCount != null ? t.personCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
              )}
              <TableCell>
                <WalkedPill walks={walks} tz={tz} />
              </TableCell>
              <TableCell>
                <OutPill active={activeWalks(walks)} />
              </TableCell>
              {compact ? null : (
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{t.campaignName}</span>
                  </Pill>
                </TableCell>
              )}
              {compact ? null : (
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{t.zoneName ?? "—"}</span>
                  </Pill>
                </TableCell>
              )}
              {compact ? null : (
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{t.segmentName ?? "—"}</span>
                  </Pill>
                </TableCell>
              )}
              {compact ? null : (
                <TableCell>
                  <Pill variant="number">{formatDate(t.createdAt, tz)}</Pill>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
