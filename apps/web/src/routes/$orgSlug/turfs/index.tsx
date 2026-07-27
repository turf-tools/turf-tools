import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  DoorClosed,
  LayoutGrid,
  LoaderCircle,
  Megaphone,
  QrCode,
  Radio,
  Rows3,
  UserRound,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { Dialog, DialogClose, DialogCloseX, DialogContent, DialogTitle } from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { formatMonthDay, formatTime } from "~/lib/format";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressQuery } from "~/lib/queries/progress";
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
type WalksPayload = Awaited<ReturnType<typeof client.walks.listForOrg>>;
type WalkRow = WalksPayload["walks"][number];

// Observable-10 hues — the same categorical palette zones use, so the
// page reads as part of the site rather than the legacy app. The color
// rule: dynamic facts get color (walked, status, progress), static
// context stays neutral. Walked and status share blue — the icons
// disambiguate (palette teal for walked was tried and rejected: too
// close to the progress green).
const BLUE = "#4269d0";
const PROGRESS_RED = "#ff725c";
const PROGRESS_YELLOW = "#efb118";
const PROGRESS_GREEN = "#3ca951";

const blueBadge = { backgroundColor: `${BLUE}20`, color: BLUE };

// How long a scan signal reads as "pending" before it ages out (a scan
// that never converts to a walk was a failed handoff, not an
// assignment). Long enough for a first-time canvasser to type name +
// phone into the attestation sheet; short enough that a failed handoff
// clears while the lead is still at the table.
const PENDING_MS = 2 * 60_000;

function progressStyle(pct: number) {
  const color = pct <= 25 ? PROGRESS_RED : pct <= 75 ? PROGRESS_YELLOW : PROGRESS_GREEN;
  return { backgroundColor: `${color}20`, color };
}

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
      queryClient.fetchQuery(progressQuery(deps.campaignId)),
      queryClient.fetchQuery(campaignsListQuery()),
    ]),
  component: TurfsIndex,
});

// Instant board updates: the server publishes an SSE nudge when a scan
// or walk mutation lands, and we refetch immediately instead of waiting
// out the poll. The poll remains the correctness backbone — a dropped
// stream (backgrounded phone tab) just falls back to poll latency.
function useLiveRefresh() {
  const { orgSlug } = Route.useParams();
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource(`/api/web/${orgSlug}/live`);
    source.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: ["walks"] });
    };
    return () => source.close();
  }, [orgSlug, queryClient]);
}

function TurfsIndex() {
  const { campaignId, zoneId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const shouldFade = useFadeOnce("/turfs");
  useLiveRefresh();

  const { data: campaigns } = useQuery(campaignsListQuery());
  const { data: turfs } = useSuspenseQuery(turfsListQuery(campaignId));
  const rows = useTurfRows(campaignId, zoneId);

  // Mobile-only rendering choice; desktop is always the table.
  const [view, setView] = useState<"cards" | "table">("cards");

  // Dialogs: open flag and turf snapshot split so the body doesn't flash
  // empty during the close animation.
  const [qrTurf, setQrTurf] = useState<TurfRow | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const showQr = (turf: TurfRow) => {
    setQrTurf(turf);
    setQrOpen(true);
  };
  const [walksTurf, setWalksTurf] = useState<TurfRow | null>(null);
  const [walksOpen, setWalksOpen] = useState(false);
  const showWalks = (turf: TurfRow) => {
    setWalksTurf(turf);
    setWalksOpen(true);
  };

  // "Next" advances the QR dialog through the current filter's rows in
  // display order — show, scan, next, without leaving the dialog. Stops
  // at the end (no wrap: silently returning to turf 01 mid-run would be
  // worse than a disabled button). Skips codeless/archived turfs.
  const nextQrTurf = useMemo(() => {
    if (!qrTurf) return null;
    const i = rows.findIndex((t) => t.turfId === qrTurf.turfId);
    if (i < 0) return null;
    return rows.slice(i + 1).find((t) => t.turfCode && t.status === "active") ?? null;
  }, [rows, qrTurf]);

  const onSearchChange = (patch: Partial<TurfsSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  const campaignOptions = campaigns?.map((c) => ({ value: c.campaignId, label: c.name })) ?? [];
  const campaignName =
    campaignId === null
      ? null
      : (campaigns?.find((c) => c.campaignId === campaignId)?.name ?? null);

  // Region options come from the turfs in view (already campaign-scoped),
  // so the filter never offers a region with nothing behind it. Zoneless
  // campaigns cut against the whole segment, so the segment stands in as
  // the region — organizers think in zones, and a second segment column
  // (or filter) would be noise.
  const regionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of turfs) {
      const id = regionId(t);
      const name = regionName(t);
      if (id && name && !seen.has(id)) seen.set(id, name);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [turfs]);
  const regionLabel =
    zoneId === null ? null : (regionOptions.find((z) => z.value === zoneId)?.label ?? null);

  const campaignFilter = (allLabel: string | null) => (
    <Filter
      icon={<Megaphone className="size-3.5" />}
      label={campaignName ?? allLabel ?? "Campaign"}
      value={campaignId}
      options={campaignOptions}
      allLabel={allLabel}
      onChange={(next) => onSearchChange({ campaignId: next, zoneId: null })}
    />
  );
  const zoneFilter = (allLabel: string | null) => (
    <Filter
      icon={<Waypoints className="size-3.5" />}
      label={regionLabel ?? allLabel ?? "Zone"}
      value={zoneId}
      options={regionOptions}
      allLabel={allLabel}
      onChange={(next) => onSearchChange({ zoneId: next })}
    />
  );

  // Mobile requires a scope — a launch table works one campaign or zone,
  // and dropping "all" keeps the list small and the lead oriented.
  const mobileScoped = campaignId !== null || zoneId !== null;

  return (
    <Page className={shouldFade}>
      {/* Desktop header */}
      <div className="hidden md:block">
        <EditorHeader title="Turfs">
          {campaignFilter("All campaigns")}
          {zoneFilter("All zones")}
        </EditorHeader>
      </div>
      {/* Mobile header: title row, then controls left-aligned */}
      <div className="mb-5 flex flex-col gap-3 md:hidden">
        <h1 className="text-xl font-extrabold tracking-wide italic">Turfs</h1>
        <div className="flex items-center gap-2">
          {campaignFilter(null)}
          {zoneFilter(null)}
          <span className="flex-1" />
          <ToggleGroup
            variant="outline"
            value={[view]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "cards" || next === "table") setView(next);
            }}
          >
            <ToggleGroupItem value="cards" aria-label="Cards">
              <LayoutGrid className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Table">
              <Rows3 className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="md:hidden">
        {!mobileScoped ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Select a campaign or zone to see turfs
          </div>
        ) : view === "cards" ? (
          <TurfCards campaignId={campaignId} zoneId={zoneId} onShowQr={showQr} />
        ) : (
          <CompactList
            campaignId={campaignId}
            zoneId={zoneId}
            onShowQr={showQr}
            onShowWalks={showWalks}
          />
        )}
      </div>
      <div className="hidden md:block">
        <TurfsTable
          campaignId={campaignId}
          zoneId={zoneId}
          onShowQr={showQr}
          onShowWalks={showWalks}
        />
      </div>
      <QrDialog
        turf={qrTurf}
        campaignId={campaignId}
        open={qrOpen}
        onOpenChange={setQrOpen}
        onNext={nextQrTurf ? () => setQrTurf(nextQrTurf) : null}
      />
      <WalksDialog
        turf={walksTurf}
        campaignId={campaignId}
        open={walksOpen}
        onOpenChange={setWalksOpen}
      />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

// Zoneless campaigns cut against the whole segment; the segment is the
// region there.
function regionId(t: TurfRow) {
  return t.zoneId ?? (t.segmentId ? `segment:${t.segmentId}` : null);
}
function regionName(t: TurfRow) {
  return t.zoneName ?? t.segmentName;
}

// Everything the board needs, derived from a turf's walks plus its scan
// signal. There are no lead-written states — the lead only shows codes:
// `pending` means a code resolution happened recently but no walk has
// landed yet (attestation typing, slow network — or a handoff that will
// quietly fail and age out), `live` means a walk is open right now.
// Both decay by display rule rather than mutation: a walk open past
// LIVE_MS stops reading as live (the canvasser went home without
// closing), while its row stays honestly open in the data.
type WalkSummary = {
  walks: WalkRow[];
  names: string[]; // distinct canvassers who ever signed it out
  live: boolean;
  pending: boolean;
};

const LIVE_MS = 12 * 60 * 60_000;

function summarize(walks: WalkRow[], scannedAt: Date | string | undefined): WalkSummary {
  const names: string[] = [];
  for (const w of walks) {
    if (!names.includes(w.canvasserName)) names.push(w.canvasserName);
  }
  const live = walks.some(
    (w) => !w.closedAt && Date.now() - new Date(w.openedAt).getTime() < LIVE_MS,
  );
  let pending = false;
  if (scannedAt && !live) {
    const t = new Date(scannedAt).getTime();
    pending =
      Date.now() - t < PENDING_MS && !walks.some((w) => new Date(w.openedAt).getTime() >= t);
  }
  return { walks, names, live, pending };
}

function useTurfRows(campaignId: string | null, zoneId: string | null) {
  const { data } = useSuspenseQuery(turfsListQuery(campaignId));
  // Bulk publish writes all rows in a single statement, so they share a
  // created_at; name (natural-numeric) breaks the tie so "Turf 2" stays
  // ahead of "Turf 10" within a single publish batch.
  return useMemo(
    () =>
      data
        .filter((t) => zoneId === null || regionId(t) === zoneId)
        .sort((a, b) => {
          const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          if (t !== 0) return t;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        }),
    [data, zoneId],
  );
}

function useWalkSummaries(campaignId: string | null) {
  const { data } = useQuery(walksListQuery(campaignId));
  return useMemo(() => {
    const byTurf = new Map<string, WalkRow[]>();
    for (const w of data?.walks ?? []) {
      const list = byTurf.get(w.turfId);
      if (list) list.push(w);
      else byTurf.set(w.turfId, [w]);
    }
    const scanByTurf = new Map((data?.scans ?? []).map((s) => [s.turfId, s.scannedAt]));
    return (turfId: string) => summarize(byTurf.get(turfId) ?? [], scanByTurf.get(turfId));
  }, [data]);
}

function useProgressByTurf(campaignId: string | null) {
  const { data } = useQuery(progressQuery(campaignId));
  return useMemo(() => new Map((data ?? []).map((r) => [r.turfId, r.attempted])), [data]);
}

// "01" — the label is the number; the word is the column header's job.
function turfLabel(name: string) {
  const label = name.replace(/^turf\s+/i, "");
  return /^\d+$/.test(label) ? label.padStart(2, "0") : label;
}

function progressPct(attempted: number | undefined, personCount: number | null) {
  if (!personCount) return null;
  return Math.round(((attempted ?? 0) / personCount) * 100);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

// The payload matches the native scanner's expected format (see
// parseTurfQr): a real URL so a system-camera scan can someday land on a
// web page, with `/t/` as the format discriminator.
function qrValue(code: string) {
  return `${window.location.origin}/t/${code}`;
}

// Walk state inside the dialog, so a lead flipping through with Next
// can't accidentally re-hand-out a turf that's already pending, out, or
// walked. Rendered as an inset card matching the QR/code plates: white
// for the calm state, blue for now-activity, teal for walked history.
// Live via the same summaries the board uses — a scan landing while the
// dialog is open flips this card in front of the lead.
function QrStatus({ summary }: { summary: WalkSummary }) {
  const card = "flex items-center gap-2 rounded-lg border p-2.5 text-sm shadow-inner";
  if (summary.live) {
    return (
      <div className={card} style={{ ...blueBadge, borderColor: `${BLUE}40` }}>
        <Radio className="size-4 shrink-0 [stroke-width:2.5]" />
        <span className="truncate">Out with {summary.names.join(", ")}</span>
      </div>
    );
  }
  if (summary.pending) {
    return (
      <div className={card} style={{ ...blueBadge, borderColor: `${BLUE}40` }}>
        <LoaderCircle className="size-4 shrink-0 animate-spin [stroke-width:2.5]" />
        <span>Signing out…</span>
      </div>
    );
  }
  if (summary.walks.length > 0) {
    return (
      <div className={card} style={{ ...blueBadge, borderColor: `${BLUE}40` }}>
        {summary.walks.length >= 2 ? (
          <CheckCheck className="size-4 shrink-0 [stroke-width:2.5]" />
        ) : (
          <Check className="size-4 shrink-0 [stroke-width:2.5]" />
        )}
        <span className="truncate">Walked by {summary.names.join(", ")}</span>
      </div>
    );
  }
  return (
    <div className={cn(card, "border-border bg-white text-muted-foreground")}>
      Needs to be signed out
    </div>
  );
}

function QrDialog({
  turf,
  campaignId,
  open,
  onOpenChange,
  onNext,
}: {
  turf: TurfRow | null;
  campaignId: string | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onNext: (() => void) | null;
}) {
  const summaries = useWalkSummaries(campaignId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[300px] max-w-[80vw]">
        {turf?.turfCode ? (
          <>
            <DialogTitle className="text-sm font-normal tracking-normal text-foreground italic">
              Turf {turfLabel(turf.name)}
              {regionName(turf) ? ` — ${regionName(turf)}` : ""}
            </DialogTitle>
            <div className="flex flex-col gap-3">
              <QrStatus summary={summaries(turf.turfId)} />
              {/* Always-white plates so the code scans in dark mode. */}
              <div className="rounded-lg border border-border bg-white p-4 shadow-inner">
                <QRCodeSVG
                  value={qrValue(turf.turfCode)}
                  size={512}
                  marginSize={0}
                  className="h-auto w-full"
                />
              </div>
              <div className="rounded-lg border border-border bg-white py-2 text-center shadow-inner">
                <span className="font-mono text-2xl tracking-widest text-black tabular-nums">
                  {turf.turfCode}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <Button
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(turf.turfCode!)}
                >
                  <Copy className="size-3.5" />
                  Copy
                </Button>
                <span className="flex items-center gap-2">
                  <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
                  <Button disabled={!onNext} onClick={() => onNext?.()}>
                    Next
                  </Button>
                </span>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WalksDialog({
  turf,
  campaignId,
  open,
  onOpenChange,
}: {
  turf: TurfRow | null;
  campaignId: string | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const summaries = useWalkSummaries(campaignId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* pb offsets the last table row's internal height so the visual
          gap below the text matches the top. */}
      <DialogContent className="max-w-[85vw] pb-3 md:max-w-md">
        {turf ? (
          <>
            <DialogTitle className="-mt-1 text-sm font-normal tracking-normal text-foreground italic">
              Turf {turfLabel(turf.name)}
              {regionName(turf) ? ` — ${regionName(turf)}` : ""}
            </DialogTitle>
            <DialogCloseX />
            <WalkTable walks={summaries(turf.turfId).walks} tz={tz} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Indicators — badges are non-interactive (Pill); actions are Buttons
// ---------------------------------------------------------------------------

// Blue check once walked (with the most recent date — useful when
// scanning the table), double check for two or more walks. Blank (not a
// dash) when empty — the legacy card idiom.
function WalkedBadge({ summary, tz }: { summary: WalkSummary; tz: string }) {
  if (summary.walks.length === 0) return <Pill />;
  const last = summary.walks[summary.walks.length - 1]!;
  return (
    <Pill className="gap-1.5 font-mono tabular-nums" style={blueBadge}>
      {summary.walks.length >= 2 ? <CheckCheck className="size-4" /> : <Check className="size-4" />}
      {formatMonthDay(last.openedAt, tz)}
    </Pill>
  );
}

// Live signal: radio while someone has the turf open; spinner while a
// scan is in flight (code resolved, walk not yet landed). Provisional
// iconography — swap freely.
function StatusBadge({ summary }: { summary: WalkSummary }) {
  if (summary.live) {
    return (
      <Pill className="justify-center" style={blueBadge}>
        <Radio className="size-4" />
      </Pill>
    );
  }
  if (summary.pending) {
    return (
      <Pill className="justify-center" style={blueBadge}>
        <LoaderCircle className="size-4 animate-spin" />
      </Pill>
    );
  }
  return <Pill />;
}

function ProgressPill({ pct }: { pct: number | null }) {
  if (pct === null) return <Pill variant="number" />;
  return (
    <Pill variant="number" style={pct > 0 ? progressStyle(pct) : undefined}>
      {pct}%
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Walk table (expanded card + canvassers dialog)
// ---------------------------------------------------------------------------

// Inset mini-table: dividers stop at the container padding rather than
// running edge-to-edge. Read-only — the lead observes, never edits. One
// shared component for the card expansion and the canvassers dialog. No
// End column: audit detail that doesn't earn its width (Start + the
// live badge carry the story). table-fixed so a marathon name truncates
// instead of scrunching the time columns.
function WalkTable({ walks, tz }: { walks: WalkRow[]; tz: string }) {
  if (walks.length === 0) {
    return <div className="py-2 text-sm text-muted-foreground">No walks yet</div>;
  }
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="h-8 w-16 font-normal">Walked</th>
          <th className="h-8 font-normal">Canvasser</th>
          <th className="h-8 w-20 font-normal">Start</th>
        </tr>
      </thead>
      <tbody>
        {[...walks].reverse().map((w) => (
          <tr key={w.walkId} className="border-t border-border">
            <td className="h-9 font-mono tabular-nums">{formatMonthDay(w.openedAt, tz)}</td>
            <td className="h-9 pr-2">
              <span className="block truncate">{w.canvasserName}</span>
            </td>
            <td className="h-9 font-mono tabular-nums">{formatTime(w.openedAt, tz)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const summaries = useWalkSummaries(campaignId);
  const progressByTurf = useProgressByTurf(campaignId);

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
          summary={summaries(t.turfId)}
          pct={progressPct(progressByTurf.get(t.turfId), t.personCount)}
          tz={tz}
          onShowQr={onShowQr}
        />
      ))}
    </div>
  );
}

// Layout follows the legacy turf-app card: label + status badges upper
// left; doors / people / progress badges upper right; caret + code lower
// left, Scan action lower right.
function TurfCard({
  turf,
  summary,
  pct,
  tz,
  onShowQr,
}: {
  turf: TurfRow;
  summary: WalkSummary;
  pct: number | null;
  tz: string;
  onShowQr: (turf: TurfRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const badge = "flex h-7 items-center gap-1 rounded-md px-2 text-sm";
  return (
    <div className="rounded-lg border border-border bg-white dark:bg-transparent">
      <div className="flex items-center gap-1.5 p-3">
        <span className="w-8 text-lg font-bold tabular-nums">{turfLabel(turf.name)}</span>
        {summary.walks.length > 0 ? (
          <span className={badge} style={blueBadge}>
            {summary.walks.length >= 2 ? (
              <CheckCheck className="size-4 [stroke-width:2.5]" />
            ) : (
              <Check className="size-4 [stroke-width:2.5]" />
            )}
          </span>
        ) : null}
        {summary.live ? (
          <span className={badge} style={blueBadge}>
            <Radio className="size-4 [stroke-width:2.5]" />
          </span>
        ) : summary.pending ? (
          <span className={badge} style={blueBadge}>
            <LoaderCircle className="size-4 animate-spin [stroke-width:2.5]" />
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <span className={cn(badge, "bg-muted font-mono tabular-nums")}>
            <DoorClosed className="size-3.5" />
            {turf.doorCount != null ? turf.doorCount.toLocaleString() : "—"}
          </span>
          <span className={cn(badge, "bg-muted font-mono tabular-nums")}>
            <UserRound className="size-3.5" />
            {turf.personCount != null ? turf.personCount.toLocaleString() : "—"}
          </span>
          {pct !== null ? (
            <span
              className={cn(badge, "bg-muted font-mono tabular-nums")}
              style={pct > 0 ? progressStyle(pct) : undefined}
            >
              {pct}%
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex items-center gap-3 px-3 pt-1 pb-3">
        {/* Bare caret: aligned to the label's left edge, no button chrome. */}
        <button
          type="button"
          aria-label="History"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center"
        >
          <ChevronDown
            className={cn(
              "size-5 text-muted-foreground [stroke-width:2.5] transition-transform duration-150",
              expanded && "rotate-180",
            )}
          />
        </button>
        <span className="font-mono text-sm tabular-nums">{turf.turfCode ?? "—"}</span>
        <span className="flex-1" />
        <Button
          variant="outline"
          disabled={!turf.turfCode || turf.status !== "active"}
          onClick={() => onShowQr(turf)}
        >
          <QrCode className="size-3.5" />
          Scan
        </Button>
      </div>
      {expanded ? (
        <div className="px-3 pt-2 pb-3">
          <WalkTable walks={summary.walks} tz={tz} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact list (mobile table view) — the legacy dense-scan mode: no
// headers, icon-only cells, everything fits an iPhone width without
// horizontal scroll.
// ---------------------------------------------------------------------------

function CompactList({
  campaignId,
  zoneId,
  onShowQr,
  onShowWalks,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  onShowWalks: (turf: TurfRow) => void;
}) {
  const rows = useTurfRows(campaignId, zoneId);
  const summaries = useWalkSummaries(campaignId);
  const progressByTurf = useProgressByTurf(campaignId);

  if (rows.length === 0) {
    return (
      <Pill>
        <span>No results</span>
      </Pill>
    );
  }
  const cell = "flex h-8 shrink-0 items-center justify-center rounded-md text-sm";
  return (
    <div className="flex flex-col gap-1 pb-8">
      {rows.map((t) => {
        const summary = summaries(t.turfId);
        const pct = progressPct(progressByTurf.get(t.turfId), t.personCount);
        return (
          <div key={t.turfId} className="flex items-center gap-1">
            <span className={cn(cell, "w-9 bg-muted font-mono font-semibold tabular-nums")}>
              {turfLabel(t.name)}
            </span>
            <Button
              variant="outline"
              aria-label="Scan"
              className="min-w-0 flex-1"
              disabled={!t.turfCode || t.status !== "active"}
              onClick={() => onShowQr(t)}
            >
              <QrCode className="size-3.5" />
            </Button>
            <span
              className={cn(cell, "w-9", summary.walks.length === 0 && "bg-muted")}
              style={summary.walks.length > 0 ? blueBadge : undefined}
            >
              {summary.walks.length >= 2 ? (
                <CheckCheck className="size-4 [stroke-width:2.5]" />
              ) : summary.walks.length === 1 ? (
                <Check className="size-4 [stroke-width:2.5]" />
              ) : null}
            </span>
            <span
              className={cn(cell, "w-9", !summary.live && !summary.pending && "bg-muted")}
              style={summary.live || summary.pending ? blueBadge : undefined}
            >
              {summary.live ? (
                <Radio className="size-4 [stroke-width:2.5]" />
              ) : summary.pending ? (
                <LoaderCircle className="size-4 animate-spin [stroke-width:2.5]" />
              ) : null}
            </span>
            <span
              className={cn(cell, "w-16 justify-start gap-1 bg-muted px-2 font-mono tabular-nums")}
            >
              <DoorClosed className="size-3.5 shrink-0" />
              {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
            </span>
            <span
              className={cn(cell, "w-12 justify-start bg-muted px-2 font-mono tabular-nums")}
              style={pct !== null && pct > 0 ? progressStyle(pct) : undefined}
            >
              {pct === null ? "" : `${pct}%`}
            </span>
            <Button
              variant="outline"
              aria-label="Canvassers"
              className="min-w-0 flex-1"
              disabled={summary.walks.length === 0}
              onClick={() => onShowWalks(t)}
            >
              <UsersRound className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table (desktop)
// ---------------------------------------------------------------------------

function TurfsTable({
  campaignId,
  zoneId,
  onShowQr,
  onShowWalks,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  onShowWalks: (turf: TurfRow) => void;
}) {
  const { session } = Route.useRouteContext();
  const tz = session?.user.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const rows = useTurfRows(campaignId, zoneId);
  const summaries = useWalkSummaries(campaignId);
  const progressByTurf = useProgressByTurf(campaignId);

  return (
    <Table containerClassName="h-[calc(100vh-9rem)] overflow-y-auto" className="table-fixed">
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
        <TableRow>
          <TableHead className="w-14">Turf</TableHead>
          <TableHead className="w-30">Code</TableHead>
          <TableHead className="w-24">Walked</TableHead>
          <TableHead className="w-16">Status</TableHead>
          <TableHead className="w-22">Doors</TableHead>
          <TableHead className="w-22">People</TableHead>
          <TableHead className="w-20">Progress</TableHead>
          <TableHead className="">Canvassers</TableHead>
          <TableHead className="">Zone</TableHead>
          <TableHead className="">Campaign</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="h-10">
            <TableCell colSpan={10}>
              <Pill>
                <span>No results</span>
              </Pill>
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((t) => {
          const summary = summaries(t.turfId);
          const pct = progressPct(progressByTurf.get(t.turfId), t.personCount);
          return (
            <TableRow key={t.turfId}>
              <TableCell>
                <Pill variant="number" className="font-semibold">
                  {turfLabel(t.name)}
                </Pill>
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={!t.turfCode || t.status !== "active"}
                  onClick={() => onShowQr(t)}
                >
                  <QrCode className="size-3.5" />
                  <span className="font-mono tabular-nums">{t.turfCode ?? "—"}</span>
                </Button>
              </TableCell>
              <TableCell>
                <WalkedBadge summary={summary} tz={tz} />
              </TableCell>
              <TableCell>
                <StatusBadge summary={summary} />
              </TableCell>
              <TableCell>
                <Pill variant="number" className="gap-1.5">
                  <DoorClosed className="size-3.5 shrink-0 text-foreground" />
                  {t.doorCount != null ? t.doorCount.toLocaleString() : "—"}
                </Pill>
              </TableCell>
              <TableCell>
                <Pill variant="number" className="gap-1.5">
                  <UserRound className="size-3.5 shrink-0 text-foreground" />
                  {t.personCount != null ? t.personCount.toLocaleString() : "—"}
                </Pill>
              </TableCell>
              <TableCell>
                <ProgressPill pct={pct} />
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={summary.walks.length === 0}
                  onClick={() => onShowWalks(t)}
                >
                  <UsersRound className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{summary.names.join(", ")}</span>
                </Button>
              </TableCell>
              <TableCell>
                <Pill className="min-w-0">
                  <span className="truncate">{regionName(t) ?? "—"}</span>
                </Pill>
              </TableCell>
              <TableCell>
                <Pill className="min-w-0">
                  <span className="truncate">{t.campaignName}</span>
                </Pill>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
