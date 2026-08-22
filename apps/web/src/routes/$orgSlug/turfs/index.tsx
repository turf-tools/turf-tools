import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Feature, FeatureCollection } from "geojson";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  DoorClosed,
  LayoutGrid,
  LoaderCircle,
  Map as MapIcon,
  Megaphone,
  Phone,
  QrCode,
  Radio,
  Rows3,
  UserRound,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { useAtomValue } from "jotai";
import polylabel from "polylabel";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { Dialog, DialogClose, DialogCloseX, DialogContent, DialogTitle } from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
import { Filter } from "~/components/filter";
import { Map as MapView } from "~/components/map";
import { Page } from "~/components/page";
import { tintStyle } from "~/components/badge";
import { BLUE, GREEN, RED, YELLOW } from "~/lib/palette";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import { formatMonthDay, formatTime } from "~/lib/format";
import { campaignsListQuery } from "~/lib/queries/campaigns";
import { progressQuery } from "~/lib/queries/progress";
import { turfMapDataQuery, turfsListQuery, zoneMapDataQuery } from "~/lib/queries/turfs";
import { walksListQuery } from "~/lib/queries/walks";
import { darkAtom } from "~/lib/atoms/theme";
import { colorFor } from "~/lib/zone-colors";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { cn, parseHexRgb } from "~/lib/utils";
import { WALK_LIVE_MS } from "~/lib/walks";
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
// page reads as part of the site rather than the legacy app. Color has
// ONE meaning: blue = happening now (pending/live). Walked history is
// neutral — the check iconography carries it. (Both alternatives were
// tried and rejected: teal reads as the progress green, and walked-in-
// blue drowned the live signal in color.)

// How long a scan signal reads as "pending" before it ages out (a scan
// that never converts to a walk was a failed handoff, not an
// assignment). Long enough for a first-time canvasser to type name +
// phone into the attestation sheet; short enough that a failed handoff
// clears while the lead is still at the table.
const PENDING_MS = 2 * 60_000;

function progressColor(pct: number) {
  return pct <= 25 ? RED : pct <= 75 ? YELLOW : GREEN;
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

  // SPA-shell cold boots skip route loaders, so data arrives via component
  // mount; suspending keeps the campaign filter from painting label-less.
  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
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
  // Map-of-a-group dialog: the group is every turf sharing the clicked
  // row's (campaign, region) — resolved against the zone-unfiltered rows
  // so the map always shows the whole zone, whatever the filter.
  const allRows = useTurfRows(campaignId, null);
  const [zoneMapGroup, setZoneMapGroup] = useState<ZoneMapGroup | null>(null);
  const [zoneMapOpen, setZoneMapOpen] = useState(false);
  const showZoneMap = (turf: TurfRow) => {
    const region = regionName(turf);
    setZoneMapGroup({
      campaignId: turf.campaignId,
      zoneId: turf.zoneId,
      name: region ? `${turf.campaignName} / ${region}` : turf.campaignName,
      turfs: allRows.filter(
        (r) => r.campaignId === turf.campaignId && regionId(r) === regionId(turf),
      ),
    });
    setZoneMapOpen(true);
  };
  // Single-turf map dialog — the hand-off view: just this turf's
  // boundary and building dots.
  const [turfMapTurf, setTurfMapTurf] = useState<TurfRow | null>(null);
  const [turfMapOpen, setTurfMapOpen] = useState(false);
  const showTurfMap = (turf: TurfRow) => {
    setTurfMapTurf(turf);
    setTurfMapOpen(true);
  };
  // Both viewport trees stay mounted (CSS-gated), so match by data
  // attribute and take the visible element.
  const scrollToTurf = (turfId: string) => {
    setZoneMapOpen(false);
    requestAnimationFrame(() => {
      const el = Array.from(document.querySelectorAll(`[data-turf-row="${turfId}"]`)).find(
        (node): node is HTMLElement => node instanceof HTMLElement && node.offsetParent !== null,
      );
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // Back/Next page the QR dialog through the current filter's rows in
  // display order — show, scan, next, without leaving the dialog (Back
  // covers "did the previous one actually finish?"). Both stop at the
  // ends (no wrap: silently returning to turf 01 mid-run would be worse
  // than a disabled button) and skip codeless/archived turfs.
  const [prevQrTurf, nextQrTurf] = useMemo(() => {
    if (!qrTurf) return [null, null];
    const i = rows.findIndex((t) => t.turfId === qrTurf.turfId);
    if (i < 0) return [null, null];
    const showable = (t: TurfRow) => Boolean(t.turfCode) && t.status === "active";
    return [
      rows.slice(0, i).reverse().find(showable) ?? null,
      rows.slice(i + 1).find(showable) ?? null,
    ];
  }, [rows, qrTurf]);

  const onSearchChange = (patch: Partial<TurfsSearch>, replace = false) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  };

  const campaignOptions =
    campaigns?.filter((c) => !c.isArchived).map((c) => ({ value: c.campaignId, label: c.name })) ??
    [];
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
    zoneId === null ? "All zones" : (regionOptions.find((z) => z.value === zoneId)?.label ?? null);

  // Same filters on every viewport, "All" available and default — no
  // per-viewport conditioning. Changing the campaign resets the zone,
  // full stop — one predictable rule in every direction. Anything
  // cleverer breaks: a held-over zone can be invalid for the new
  // campaign (different zone group, or a same-named zone under a
  // different id), and zone validity is only provable from the All
  // view's rows, so a conditional hold acts differently depending on
  // where you came from.
  const campaignFilter = (
    <Filter
      icon={<Megaphone className="size-3.5" />}
      label={campaignId === null ? "All campaigns" : campaignName}
      value={campaignId}
      options={campaignOptions}
      allLabel="All campaigns"
      onChange={(next) => onSearchChange({ campaignId: next, zoneId: null })}
    />
  );
  const zoneFilter = (
    <Filter
      icon={<Waypoints className="size-3.5" />}
      label={regionLabel}
      value={zoneId}
      options={regionOptions}
      allLabel="All zones"
      onChange={(next) => onSearchChange({ zoneId: next })}
    />
  );

  return (
    <Page className={shouldFade}>
      {/* Desktop header */}
      <div className="hidden md:block">
        <EditorHeader title="Turfs">
          {campaignFilter}
          {zoneFilter}
        </EditorHeader>
      </div>
      {/* Mobile header: title, then campaign + view toggle, then zone —
          two filter rows so long campaign/zone names can't push the row
          off-screen. */}
      <div className="mb-5 flex flex-col gap-3 md:hidden">
        <h1 className="text-xl font-extrabold tracking-wide italic">Turfs</h1>
        <div className="flex items-center gap-2">
          {campaignFilter}
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
        <div className="flex items-center">{zoneFilter}</div>
      </div>
      <div className="md:hidden">
        {view === "cards" ? (
          <TurfCards
            campaignId={campaignId}
            zoneId={zoneId}
            onShowQr={showQr}
            onShowZoneMap={showZoneMap}
            onShowTurfMap={showTurfMap}
          />
        ) : (
          <CompactList
            campaignId={campaignId}
            zoneId={zoneId}
            onShowQr={showQr}
            onShowWalks={showWalks}
            onShowZoneMap={showZoneMap}
            onShowTurfMap={showTurfMap}
          />
        )}
      </div>
      <div className="hidden md:block">
        <TurfsTable
          campaignId={campaignId}
          zoneId={zoneId}
          onShowQr={showQr}
          onShowWalks={showWalks}
          onShowZoneMap={showZoneMap}
          onShowTurfMap={showTurfMap}
        />
      </div>
      <QrDialog
        turf={qrTurf}
        campaignId={campaignId}
        open={qrOpen}
        onOpenChange={setQrOpen}
        onBack={prevQrTurf ? () => setQrTurf(prevQrTurf) : null}
        onNext={nextQrTurf ? () => setQrTurf(nextQrTurf) : null}
      />
      <WalksDialog
        turf={walksTurf}
        campaignId={campaignId}
        open={walksOpen}
        onOpenChange={setWalksOpen}
      />
      <ZoneMapDialog
        group={zoneMapGroup}
        open={zoneMapOpen}
        onOpenChange={setZoneMapOpen}
        onSelectTurf={scrollToTurf}
      />
      <TurfMapDialog turf={turfMapTurf} open={turfMapOpen} onOpenChange={setTurfMapOpen} />
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
// WALK_LIVE_MS stops reading as live (the canvasser went home without
// closing), while its row stays honestly open in the data.
type WalkSummary = {
  walks: WalkRow[];
  names: string[]; // distinct canvassers who ever signed it out
  activeNames: string[]; // distinct canvassers out right now
  live: boolean;
  // A scan is only recorded for unattributed devices (identity sheet in
  // progress), so pending is a hard state — no display debouncing needed.
  pending: boolean;
};

function summarize(walks: WalkRow[], scannedAt: Date | string | undefined): WalkSummary {
  const names: string[] = [];
  const activeNames: string[] = [];
  for (const w of walks) {
    if (!names.includes(w.canvasserName)) names.push(w.canvasserName);
    const isActive = !w.closedAt && Date.now() - new Date(w.openedAt).getTime() < WALK_LIVE_MS;
    if (isActive && !activeNames.includes(w.canvasserName)) activeNames.push(w.canvasserName);
  }
  const live = activeNames.length > 0;
  let pending = false;
  if (scannedAt && !live) {
    const t = new Date(scannedAt).getTime();
    pending =
      Date.now() - t < PENDING_MS && !walks.some((w) => new Date(w.openedAt).getTime() >= t);
  }
  return { walks, names, activeNames, live, pending };
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

// Null until progress loads — a turf absent from a loaded result means
// genuinely zero attempts; an absent result means "don't know yet".
function useProgressByTurf(campaignId: string | null) {
  const { data } = useQuery(progressQuery(campaignId));
  return useMemo(() => (data ? new Map(data.map((r) => [r.turfId, r.attempted])) : null), [data]);
}

// Region-grouped rendering for the mobile views: one group per
// (campaign, region) in row order — keyed on both because zone groups
// can be shared across campaigns — headed "Campaign / Zone". Always on,
// even filtered to a single zone: the heading anchors context once the
// filters scroll away, and the layout stays put across filter changes.
function groupRows(rows: TurfRow[]) {
  const groups: { key: string; name: string | null; rows: TurfRow[] }[] = [];
  const index = new Map<string, number>();
  for (const t of rows) {
    const key = `${t.campaignId}:${regionId(t) ?? "none"}`;
    let i = index.get(key);
    if (i === undefined) {
      i = groups.length;
      index.set(key, i);
      const region = regionName(t);
      groups.push({
        key,
        name: region ? `${t.campaignName} / ${region}` : t.campaignName,
        rows: [],
      });
    }
    groups[i]!.rows.push(t);
  }
  return groups;
}

// Mobile group heading — "Campaign / Zone" label with a right-aligned
// "View map" text action (baseline-aligned with the label, no button
// chrome) that opens the whole zone, no turf highlighted. The label
// gets the remaining width and wraps rather than pushing the action off.
function GroupHeader({
  group,
  onShowZoneMap,
  className,
}: {
  group: { name: string | null; rows: TurfRow[] };
  onShowZoneMap: (turf: TurfRow) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-6", className)}>
      <p className="min-w-0 flex-1 text-muted-foreground leading-5">{group.name}</p>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 text-muted-foreground leading-5"
        onClick={() => onShowZoneMap(group.rows[0]!)}
      >
        View map
        <MapIcon className="size-3.5" />
      </button>
    </div>
  );
}

// "01" — the label is the number; the word is the column header's job.
function turfLabel(name: string) {
  const label = name.replace(/^turf\s+/i, "");
  return /^\d+$/.test(label) ? label.padStart(2, "0") : label;
}

// Door counts get three characters: past 999 the exact number stops
// mattering on the board, and "1k+" keeps the cell width fixed.
function doorLabel(count: number | null) {
  if (count == null) return "—";
  return count > 999 ? "1k+" : String(count);
}

function progressPct(attempted: number, personCount: number | null) {
  if (!personCount) return null;
  return Math.round((attempted / personCount) * 100);
}

function bboxOfFeatures(features: Feature[]): [number, number, number, number] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      minLng = Math.min(minLng, coords[0]);
      maxLng = Math.max(maxLng, coords[0]);
      minLat = Math.min(minLat, coords[1]);
      maxLat = Math.max(maxLat, coords[1]);
      return;
    }
    for (const c of coords) visit(c);
  };
  for (const f of features) {
    if ("coordinates" in f.geometry) visit(f.geometry.coordinates);
  }
  return minLng === Infinity ? null : [minLng, minLat, maxLng, maxLat];
}

// Pole of inaccessibility — guaranteed interior, unlike a centroid on
// L-shaped turfs. `badge` requests the map's plate treatment.
function labelPoint(f: Feature, label: string): Feature {
  let coordinates: [number, number];
  if (f.geometry.type === "Polygon") {
    // GeoJSON Position is number[]; polylabel's types want strict pairs.
    const p = polylabel(f.geometry.coordinates as [number, number][][], 0.00001);
    coordinates = [p[0]!, p[1]!];
  } else {
    const b = bboxOfFeatures([f]);
    coordinates = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
  }
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    // Carries the shape's id so badge taps can resolve back to a turf.
    properties: { label, badge: true, zoneId: f.properties?.zoneId },
  };
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

// "Prefix First Last +N": the first name truncates to the available
// space; the overflow count is pinned and never clipped, so multiple
// walkers always register even at dialog width.
function NamesLine({ prefix, names }: { prefix: string; names: string[] }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="truncate">
        {prefix} {names[0]}
      </span>
      {names.length > 1 ? <span className="shrink-0">+{names.length - 1}</span> : null}
    </span>
  );
}

// Walk state inside the dialog, so a lead flipping through with Next
// can't accidentally re-hand-out a turf that's already pending, out, or
// walked. Rendered as an inset card matching the QR/code plates: white
// for the calm state, blue for now-activity, teal for walked history.
// Live via the same summaries the board uses — a scan landing while the
// dialog is open flips this card in front of the lead.
function QrStatus({ summary }: { summary: WalkSummary }) {
  const { pending } = summary;
  const card = "flex items-center gap-2 rounded-lg border p-2.5 text-sm shadow-inner";
  if (summary.live) {
    return (
      <div
        className={cn(card, "badge-tint border-black/15 dark:border-white/18")}
        style={tintStyle(BLUE)}
      >
        <Radio className="size-4 shrink-0 [stroke-width:2.5]" />
        <NamesLine prefix="Out with" names={summary.activeNames} />
      </div>
    );
  }
  if (pending) {
    return (
      <div
        className={cn(card, "badge-tint border-black/15 dark:border-white/18")}
        style={tintStyle(BLUE)}
      >
        <LoaderCircle className="size-4 shrink-0 animate-spin [stroke-width:2.5]" />
        <span>Signing out…</span>
      </div>
    );
  }
  if (summary.walks.length > 0) {
    return (
      <div className={cn(card, "border-border bg-white text-foreground dark:bg-transparent")}>
        {summary.walks.length >= 2 ? (
          <CheckCheck className="size-4 shrink-0 [stroke-width:2.5]" />
        ) : (
          <Check className="size-4 shrink-0 [stroke-width:2.5]" />
        )}
        <NamesLine prefix="Walked by" names={summary.names} />
      </div>
    );
  }
  return (
    <div className={cn(card, "border-border bg-white text-muted-foreground dark:bg-transparent")}>
      Needs to be signed out
    </div>
  );
}

function QrDialog({
  turf,
  campaignId,
  open,
  onOpenChange,
  onBack,
  onNext,
}: {
  turf: TurfRow | null;
  campaignId: string | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onBack: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const summaries = useWalkSummaries(campaignId);
  // Copy feedback: the icon inside the code plate flips to a check for a
  // beat. Reset whenever the dialog moves to another turf.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [turf?.turfId]);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[300px] max-w-[80vw]">
        {turf?.turfCode ? (
          <>
            <DialogTitle className="text-sm font-normal tracking-normal text-foreground italic tabular-nums">
              Turf {turfLabel(turf.name)}
              {regionName(turf) ? ` — ${regionName(turf)}` : ""}
            </DialogTitle>
            <div className="flex flex-col gap-3">
              <QrStatus summary={summaries(turf.turfId)} />
              {/* QR plate stays white in dark mode — inverted codes are
                  off-spec and many scanners can't read them. */}
              <div className="rounded-lg border border-border bg-white p-4 shadow-inner">
                <QRCodeSVG
                  value={qrValue(turf.turfCode)}
                  size={512}
                  marginSize={0}
                  className="h-auto w-full"
                />
              </div>
              {/* The whole plate copies the code; the icon is the
                  affordance (and flips to a check as feedback). */}
              <button
                type="button"
                aria-label="Copy code"
                onClick={() => {
                  void navigator.clipboard.writeText(turf.turfCode!);
                  setCopied(true);
                }}
                className={cn(
                  "flex w-full items-center justify-center gap-2.5",
                  "rounded-lg border border-border bg-white py-2 shadow-inner dark:bg-transparent",
                )}
              >
                <span className="font-mono text-2xl tracking-widest text-foreground tabular-nums">
                  {turf.turfCode}
                </span>
                {copied ? (
                  <Check className="size-4 shrink-0 text-foreground [stroke-width:2.5] animate-in fade-in duration-300" />
                ) : (
                  <Copy className="size-4 shrink-0 text-foreground [stroke-width:2.5] animate-in fade-in duration-300" />
                )}
              </button>
              <div className="mt-1 flex items-center justify-between">
                <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
                <span className="flex items-center gap-2">
                  <Button variant="outline" disabled={!onBack} onClick={() => onBack?.()}>
                    Back
                  </Button>
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

type ZoneMapGroup = {
  campaignId: string;
  zoneId: string | null;
  name: string;
  turfs: TurfRow[];
};

// A group's turfs on a map — geometry, number badges, and building
// dots, colored by the app palette in row order. Scoped to one
// (campaign, region) by construction, so overlapping campaigns can't
// collide here the way they can in the full map view.
function ZoneMapDialog({
  group,
  open,
  onOpenChange,
  onSelectTurf,
}: {
  group: ZoneMapGroup | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSelectTurf: (turfId: string) => void;
}) {
  const isDark = useAtomValue(darkAtom);
  const { data: zoneData } = useQuery({
    ...zoneMapDataQuery(group?.campaignId ?? "", group?.zoneId ?? null),
    enabled: group !== null,
  });

  const { shapes, labels, bounds, points, pointColors } = useMemo(() => {
    const turfs = group?.turfs ?? [];
    const geometryByTurf = new Map((zoneData ?? []).map((g) => [g.turfId, g.geometry]));
    const shapeFeatures: Feature[] = [];
    const labelFeatures: Feature[] = [];
    turfs.forEach((t, i) => {
      const geometry = geometryByTurf.get(t.turfId);
      if (!geometry) return;
      // Index-based palette assignment, so a turf keeps the color the
      // cutter's point clouds gave it while it was drawn.
      const feature: Feature = {
        type: "Feature",
        geometry,
        properties: {
          zoneId: t.turfId,
          color: colorFor(i),
          // Solid same-hue outline; the fill stays light enough that
          // the dots read on top of it — the dots carry the density
          // now, the fill just claims area.
          lineColor: colorFor(i),
          opacity: 0.4,
        },
      };
      shapeFeatures.push(feature);
      labelFeatures.push(labelPoint(feature, turfLabel(t.name)));
    });
    const bounds = bboxOfFeatures(shapeFeatures);

    // Building dots: the turf's hue mixed toward a theme-contrast
    // base. Dots this small are mostly anti-aliased rim, so pure
    // palette colors read inconsistently (light hues wash out against
    // the basemap); the base anchor keeps contrast even across turfs.
    // One merged buffer for the whole zone.
    const HUE_SHARE = 0.7;
    const base = isDark ? 229 : 26; // matches the points layer's theme default
    let points: { deltas: Float32Array; origin: [number, number] } | null = null;
    let pointColors: Uint8Array | null = null;
    if (zoneData && bounds) {
      const coordsByTurf = new Map(zoneData.map((r) => [r.turfId, r.buildingCoords ?? []]));
      let total = 0;
      for (const t of turfs) total += (coordsByTurf.get(t.turfId) ?? []).length;
      const origin: [number, number] = [
        mercatorX((bounds[0] + bounds[2]) / 2),
        mercatorY((bounds[1] + bounds[3]) / 2),
      ];
      const deltas = new Float32Array(total * 2);
      const colors = new Uint8Array(total * 3);
      let k = 0;
      turfs.forEach((t, i) => {
        const [r, g, b] = parseHexRgb(colorFor(i)).map((c) =>
          Math.round(base + (c - base) * HUE_SHARE),
        ) as [number, number, number];
        for (const [lng, lat] of coordsByTurf.get(t.turfId) ?? []) {
          deltas[k * 2] = mercatorX(lng) - origin[0];
          deltas[k * 2 + 1] = mercatorY(lat) - origin[1];
          colors[k * 3] = r;
          colors[k * 3 + 1] = g;
          colors[k * 3 + 2] = b;
          k += 1;
        }
      });
      points = { deltas, origin };
      pointColors = colors;
    }

    return {
      shapes: { type: "FeatureCollection", features: shapeFeatures } as FeatureCollection,
      labels: { type: "FeatureCollection", features: labelFeatures } as FeatureCollection,
      bounds,
      points,
      pointColors,
    };
  }, [group, zoneData, isDark]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] md:w-[720px] md:max-w-[720px]">
        {group ? (
          <>
            <DialogTitle className="text-sm font-normal tracking-normal text-foreground italic">
              {group.name}
            </DialogTitle>
            <DialogCloseX />
            <MapView
              className="h-[65dvh] md:h-[60vh]"
              zonePerimeters={shapes}
              shapeLabels={labels}
              points={points}
              pointColors={pointColors}
              fitBounds={bounds}
              loading={!zoneData}
              loadingSpinner
              streetsAlwaysOn
              onBadgeClick={onSelectTurf}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// One turf on its own — boundary plus building dots, the view a lead
// wants at hand-off ("this is what you're walking"). Buildings come
// from the slim coordinates-only projection on the turf row and ride
// the shared WebGL points channel.
function TurfMapDialog({
  turf,
  open,
  onOpenChange,
}: {
  turf: TurfRow | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { data } = useQuery({
    ...turfMapDataQuery(turf?.turfId ?? ""),
    enabled: turf !== null,
  });

  const { shapes, points, bounds } = useMemo(() => {
    if (!turf || !data?.geometry) {
      return { shapes: undefined, points: null, bounds: null };
    }
    // Neutral fill (no `color` property falls through to the layer's
    // theme gray), heavier outline via the selected-zone state.
    const feature: Feature = {
      type: "Feature",
      geometry: data.geometry,
      properties: { zoneId: turf.turfId, opacity: 0.2 },
    };
    const b = bboxOfFeatures([feature]);
    // fp64 origin at the bbox center + fp32 deltas — the same split the
    // segment/campaign point buffers use, computed client-side since a
    // single turf is at most a few hundred buildings.
    const origin: [number, number] = b
      ? [mercatorX((b[0] + b[2]) / 2), mercatorY((b[1] + b[3]) / 2)]
      : [0, 0];
    const coords = data.buildingCoords ?? [];
    const deltas = new Float32Array(coords.length * 2);
    coords.forEach(([lng, lat], i) => {
      deltas[i * 2] = mercatorX(lng) - origin[0];
      deltas[i * 2 + 1] = mercatorY(lat) - origin[1];
    });
    return {
      shapes: { type: "FeatureCollection", features: [feature] } as FeatureCollection,
      points: { deltas, origin },
      bounds: b,
    };
  }, [data, turf]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] md:w-[720px] md:max-w-[720px]">
        {turf ? (
          <>
            <DialogTitle className="text-sm font-normal tracking-normal text-foreground italic tabular-nums">
              Turf {turfLabel(turf.name)}
              {regionName(turf) ? ` — ${regionName(turf)}` : ""}
            </DialogTitle>
            <DialogCloseX />
            <MapView
              className="h-[65dvh] md:h-[60vh]"
              zonePerimeters={shapes}
              points={points}
              fitBounds={bounds}
              loading={!data}
              loadingSpinner
              selectedZoneId={turf.turfId}
              streetsAlwaysOn
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// Web Mercator lng/lat → [0,1]² — must match PointsLayer's transform.
function mercatorX(lng: number) {
  return (lng + 180) / 360;
}
function mercatorY(lat: number) {
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
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
            <DialogTitle className="text-sm font-normal tracking-normal text-foreground italic tabular-nums">
              Turf {turfLabel(turf.name)} {regionName(turf) ? ` — ${regionName(turf)}` : ""}
            </DialogTitle>
            <DialogCloseX />
            {/* Scrolls past 10 rows instead of pushing the dialog past the
                viewport (it's centered, so overflow clips at both ends). */}
            {(() => {
              const walks = summaries(turf.turfId).walks;
              return (
                <div
                  className={cn("overflow-y-auto", walks.length > 10 && "max-h-[min(60vh,420px)]")}
                >
                  <WalkTable walks={walks} tz={tz} />
                </div>
              );
            })()}
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
  const last = summary.walks[summary.walks.length - 1];
  // Chrome-first: the pill paints with the table (blank = unwalked or still
  // loading, the legacy card idiom) and stays mounted so its background
  // never blinks; only the content mounts, with a fade.
  return (
    <Pill className="font-mono tabular-nums">
      {last ? (
        <span className="flex items-center gap-1.5 animate-in fade-in duration-100">
          {summary.walks.length >= 2 ? (
            <CheckCheck className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
          {formatMonthDay(last.openedAt, tz)}
        </span>
      ) : null}
    </Pill>
  );
}

// Live signal: radio while someone has the turf open; spinner while a
// scan is in flight (code resolved, walk not yet landed). Provisional
// iconography — swap freely.
function StatusBadge({ summary }: { summary: WalkSummary }) {
  const { pending } = summary;
  if (summary.live) {
    return (
      <Pill className="justify-center" color={BLUE}>
        <Radio className="size-4" />
      </Pill>
    );
  }
  if (pending) {
    return (
      <Pill className="justify-center" color={BLUE}>
        <LoaderCircle className="size-4 animate-spin" />
      </Pill>
    );
  }
  return <Pill />;
}

function ProgressPill({ pct }: { pct: number | null }) {
  // Chrome-first like WalkedBadge; the value fades in on arrival. No
  // transition on the tint: its background is 25%-alpha, and interpolating
  // from the opaque gray sags through a washed-out middle.
  return (
    <Pill variant="number" color={pct !== null && pct > 0 ? progressColor(pct) : undefined}>
      {pct !== null ? <span className="animate-in fade-in duration-100">{pct}%</span> : null}
    </Pill>
  );
}

// ---------------------------------------------------------------------------
// Walk table (expanded card + canvassers dialog)
// ---------------------------------------------------------------------------

// Inset mini-table: dividers stop at the container padding rather than
// running edge-to-edge. Read-only — the lead observes, never edits. One
// shared component for the card expansion and the canvassers dialog. No
// End column: audit detail that doesn't earn its width (Walked + the
// live badge carry the story). table-fixed so a marathon name truncates
// instead of scrunching the time column.
function WalkTable({ walks, tz }: { walks: WalkRow[]; tz: string }) {
  if (walks.length === 0) {
    return <div className="py-2 text-sm text-muted-foreground">No walks yet</div>;
  }
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="h-8 w-20 md:w-42 font-normal">Walked</th>
          <th className="h-8 font-normal">Canvasser</th>
        </tr>
      </thead>
      <tbody>
        {[...walks].reverse().map((w) => (
          <tr key={w.walkId} className="border-t border-border/60">
            <td className="h-9 font-mono tabular-nums">
              {formatMonthDay(w.openedAt, tz)}
              <span className="hidden md:inline"> {formatTime(w.openedAt, tz)}</span>
            </td>
            <td className="h-9 pr-2">
              {w.canvasserPhone ? (
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  // px tightens the hover wash; -ml matches it so the name
                  // stays flush with the column (and with phone-less rows).
                  // max-w gives back the shift + trailing pad so a truncated
                  // name + icon reaches the column edge instead of stopping
                  // a padding's-width short.
                  className="-ml-1.5 px-1.5 max-w-[calc(100%+0.75rem)] min-w-0 font-normal"
                  render={<a href={`sms:${w.canvasserPhone}`} />}
                >
                  <span className="truncate">{w.canvasserName}</span>
                  <Phone className="ml-px size-3.5 shrink-0 text-muted-foreground [stroke-width:2.25]" />
                </Button>
              ) : (
                <span className="block truncate">{w.canvasserName}</span>
              )}
            </td>
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
  onShowZoneMap,
  onShowTurfMap,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  onShowZoneMap: (turf: TurfRow) => void;
  onShowTurfMap: (turf: TurfRow) => void;
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
    <div className="flex flex-col gap-6 pb-8">
      {groupRows(rows).map((group) => (
        <div key={group.key} className="flex flex-col gap-3">
          {group.name ? <GroupHeader group={group} onShowZoneMap={onShowZoneMap} /> : null}
          {group.rows.map((t) => (
            <TurfCard
              key={t.turfId}
              turf={t}
              summary={summaries(t.turfId)}
              pct={
                progressByTurf
                  ? progressPct(progressByTurf.get(t.turfId) ?? 0, t.personCount)
                  : null
              }
              tz={tz}
              onShowQr={onShowQr}
              onShowTurfMap={onShowTurfMap}
            />
          ))}
        </div>
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
  onShowTurfMap,
}: {
  turf: TurfRow;
  summary: WalkSummary;
  pct: number | null;
  tz: string;
  onShowQr: (turf: TurfRow) => void;
  onShowTurfMap: (turf: TurfRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { pending } = summary;

  const badge = "flex h-7 items-center gap-1 rounded-md px-2 text-sm";
  // The whole card is a tap target for expansion; interactive children
  // (Scan, the walk table's actions) stop propagation.
  return (
    <div
      data-turf-row={turf.turfId}
      className="rounded-lg border border-border bg-white dark:bg-transparent"
      onClick={() => setExpanded((prev) => !prev)}
    >
      <div className="flex items-center gap-1.5 p-3">
        <span className="w-8 text-[18px] font-bold tabular-nums">{turfLabel(turf.name)}</span>
        <span className="-ml-1 flex items-center gap-1.5">
          {summary.walks.length > 0 ? (
            <span className={cn(badge, "bg-muted")}>
              {summary.walks.length >= 2 ? (
                <CheckCheck className="size-4 [stroke-width:2.5]" />
              ) : (
                <Check className="size-4 [stroke-width:2.5]" />
              )}
            </span>
          ) : null}
          {summary.live ? (
            <span className={cn(badge, "badge-tint")} style={tintStyle(BLUE)}>
              <Radio className="size-4 [stroke-width:2.5]" />
            </span>
          ) : pending ? (
            <span className={cn(badge, "badge-tint")} style={tintStyle(BLUE)}>
              <LoaderCircle className="size-4 animate-spin [stroke-width:2.5]" />
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className={cn(badge, "bg-muted font-mono tabular-nums")}>
            <UserRound className="size-3.5" />
            {turf.personCount != null ? turf.personCount.toLocaleString() : "—"}
          </span>
          <span className={cn(badge, "bg-muted font-mono tabular-nums")}>
            <DoorClosed className="size-3.5" />
            {doorLabel(turf.doorCount)}
          </span>
          {/* Chrome renders as a square placeholder until the value lands,
              then the pill hugs its content; the value fades in. */}
          <span
            className={cn(
              badge,
              "min-w-7 justify-center font-mono tabular-nums",
              pct !== null && pct > 0 ? "badge-tint" : "bg-muted",
            )}
            style={pct !== null && pct > 0 ? tintStyle(progressColor(pct)) : undefined}
          >
            {pct !== null ? <span className="animate-in fade-in duration-100">{pct}%</span> : null}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3 px-3 pt-1 pb-3">
        {/* Bare caret: aligned to the label's left edge, no button chrome. */}
        <button
          type="button"
          aria-label="History"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
          className="-ml-0.5 flex items-center"
        >
          <ChevronDown
            className={cn(
              "size-5 text-foreground [stroke-width:2.5] transition-transform duration-150",
              expanded && "scale-y-[-1]",
            )}
          />
        </button>
        <span className={cn(badge, "ml-[4px] bg-muted font-mono tabular-nums")}>
          {turf.turfCode ?? "—"}
        </span>
        <span className="flex-1" />
        {/* Row-level map: just this turf — boundary + building dots —
            so a lead deep in the list can see the turf they're about
            to hand out. The zone-level map lives on the group header. */}
        <Button
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            onShowTurfMap(turf);
          }}
        >
          <MapIcon className="size-3.5" />
          Map
        </Button>
        <Button
          variant="outline"
          disabled={!turf.turfCode || turf.status !== "active"}
          onClick={(e) => {
            e.stopPropagation();
            onShowQr(turf);
          }}
        >
          <QrCode className="size-3.5" />
          Scan
        </Button>
      </div>
      {expanded ? (
        <div className="px-3 pt-2 pb-3" onClick={(e) => e.stopPropagation()}>
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
  onShowZoneMap,
  onShowTurfMap,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  onShowWalks: (turf: TurfRow) => void;
  onShowZoneMap: (turf: TurfRow) => void;
  onShowTurfMap: (turf: TurfRow) => void;
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
    <div className="flex flex-col gap-5 pb-8">
      {groupRows(rows).map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          {group.name ? (
            <GroupHeader group={group} onShowZoneMap={onShowZoneMap} className="mb-2" />
          ) : null}
          {group.rows.map((t) => {
            const summary = summaries(t.turfId);
            const pct = progressByTurf
              ? progressPct(progressByTurf.get(t.turfId) ?? 0, t.personCount)
              : null;
            return (
              <div key={t.turfId} data-turf-row={t.turfId} className="flex items-center gap-1">
                <span className={cn(cell, "w-9 bg-muted font-mono font-semibold tabular-nums")}>
                  {turfLabel(t.name)}
                </span>
                {/* px-0 on the icon-only flex buttons: the padding is
                    invisible under justify-center but sets each
                    button's shrink floor — with three of them, default
                    padding overflows 360–375px viewports. */}
                <Button
                  variant="outline"
                  aria-label="Map"
                  className="min-w-0 flex-1 px-0"
                  onClick={() => onShowTurfMap(t)}
                >
                  <MapIcon className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  aria-label="Scan"
                  className="min-w-0 flex-1 px-0"
                  disabled={!t.turfCode || t.status !== "active"}
                  onClick={() => onShowQr(t)}
                >
                  <QrCode className="size-3.5" />
                </Button>
                <span className={cn(cell, "w-9 bg-muted")}>
                  {summary.walks.length >= 2 ? (
                    <CheckCheck className="size-4 [stroke-width:2.5]" />
                  ) : summary.walks.length === 1 ? (
                    <Check className="size-4 [stroke-width:2.5]" />
                  ) : null}
                </span>
                <CompactStatus summary={summary} cell={cell} />
                <span
                  className={cn(
                    cell,
                    "w-16 justify-start gap-1 bg-muted px-2 font-mono tabular-nums",
                  )}
                >
                  <DoorClosed className="size-3.5 shrink-0" />
                  {doorLabel(t.doorCount)}
                </span>
                <span
                  className={cn(
                    cell,
                    "w-14 justify-start px-2 font-mono tabular-nums",
                    pct !== null && pct > 0 ? "badge-tint" : "bg-muted",
                  )}
                  style={pct !== null && pct > 0 ? tintStyle(progressColor(pct)) : undefined}
                >
                  {pct !== null ? (
                    <span className="animate-in fade-in duration-100">{pct}%</span>
                  ) : null}
                </span>
                <Button
                  variant="outline"
                  aria-label="Canvassers"
                  className="min-w-0 flex-1 px-0"
                  disabled={summary.walks.length === 0}
                  onClick={() => onShowWalks(t)}
                >
                  <UsersRound className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CompactStatus({ summary, cell }: { summary: WalkSummary; cell: string }) {
  const { pending } = summary;
  const active = summary.live || pending;
  return (
    <span
      className={cn(cell, "w-9", active ? "badge-tint" : "bg-muted")}
      style={active ? tintStyle(BLUE) : undefined}
    >
      {summary.live ? (
        <Radio className="size-4 [stroke-width:2.5]" />
      ) : pending ? (
        <LoaderCircle className="size-4 animate-spin [stroke-width:2.5]" />
      ) : null}
    </span>
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
  onShowZoneMap,
  onShowTurfMap,
}: {
  campaignId: string | null;
  zoneId: string | null;
  onShowQr: (turf: TurfRow) => void;
  onShowWalks: (turf: TurfRow) => void;
  onShowZoneMap: (turf: TurfRow) => void;
  onShowTurfMap: (turf: TurfRow) => void;
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
          <TableHead className="w-20">Turf</TableHead>
          <TableHead className="w-30">Code</TableHead>
          <TableHead className="w-24">Walked</TableHead>
          <TableHead className="w-16">Status</TableHead>
          <TableHead className="w-22">People</TableHead>
          <TableHead className="w-22">Doors</TableHead>
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
          const pct = progressByTurf
            ? progressPct(progressByTurf.get(t.turfId) ?? 0, t.personCount)
            : null;
          return (
            <TableRow key={t.turfId} data-turf-row={t.turfId}>
              <TableCell>
                {/* Single-turf map (boundary + building dots); the Zone
                    cell covers the zone-in-context view. */}
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onShowTurfMap(t)}
                >
                  <MapIcon className="size-3.5 shrink-0" />
                  <span className="font-mono tabular-nums">{turfLabel(t.name)}</span>
                </Button>
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
                  <UserRound className="size-3.5 shrink-0 text-foreground" />
                  {t.personCount != null ? t.personCount.toLocaleString() : "—"}
                </Pill>
              </TableCell>
              <TableCell>
                <Pill variant="number" className="gap-1.5">
                  <DoorClosed className="size-3.5 shrink-0 text-foreground" />
                  {doorLabel(t.doorCount)}
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
                {regionName(t) ? (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onShowZoneMap(t)}
                  >
                    <MapIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{regionName(t)}</span>
                  </Button>
                ) : (
                  <Pill className="min-w-0">
                    <span className="truncate">—</span>
                  </Pill>
                )}
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
