import { Icon } from "~/components/icon";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Reorder, useDragControls } from "motion/react";
import { notify } from "~/lib/notify";
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { Badge, tintStyle } from "~/components/badge";
import { Button } from "~/components/button";
import { Map } from "~/components/map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import {
  emptyFilterFor,
  type Filter,
  type FilterDef,
  filterKey,
  isActiveStep,
  type Criteria,
  type Step,
  type Verb,
  VERB_META,
} from "~/lib/filters";
import { useRememberedState, useRememberSelection } from "~/lib/last-selected";
import {
  segmentCascadeQuery,
  segmentCountsQuery,
  segmentDetailQuery,
  segmentPointsQuery,
  segmentSampleQuery,
  segmentsListQuery,
} from "~/lib/queries/segments";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { AddStepMenu, FilterValueEditor } from "~/components/filter-editors";
import { useFilterCatalog } from "~/lib/manifest";
import type { CascadeStep } from "~/rpc/web/segments";
import { cn, toTitleCase } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/segments/$segmentId")({
  loader: async ({ context: { queryClient }, params: { orgSlug, segmentId }, preload }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    const exists = segments.some((s) => s.segmentId === segmentId);
    if (!exists) {
      // Redirect only on real navigations — a redirect thrown during a
      // hover preload gets committed and auto-navigates.
      if (preload) return;
      throw redirect({ to: "/$orgSlug/segments", params: { orgSlug } });
    }
    await queryClient.fetchQuery(segmentDetailQuery(segmentId));
    // Names + options for the canvass-response filter editor.
    await queryClient.fetchQuery(questionsWithOptionsQuery());
  },
  component: SegmentEditor,
});

function SegmentEditor() {
  const queryClient = useQueryClient();
  const { orgSlug, segmentId } = Route.useParams();
  const { sections, isLoading: catalogLoading } = useFilterCatalog();

  // The segments index redirects back here next visit.
  useRememberSelection(orgSlug, "segments", segmentId);

  // Loader prefetched, so this is a cache hit.
  const { data: activeSegmentDetail } = useQuery({
    ...segmentDetailQuery(segmentId),
  });

  // The full org segments list — already prefetched in the loader. The
  // segment-ref filter editor reads this both to populate its dropdown
  // and to detect cycles transitively.
  const { data: allSegments } = useQuery(segmentsListQuery());

  const stepsRaw = (activeSegmentDetail?.criteria as Criteria | null)?.steps ?? [];
  const stepsIdRef = useRef<string[]>([]);
  while (stepsIdRef.current.length < stepsRaw.length) stepsIdRef.current.push(crypto.randomUUID());
  const steps = stepsRaw.map((s, i) => (s.id ? s : { ...s, id: stepsIdRef.current[i]! }));

  // While a drag is active, the visual list reorders via `draft`; queries
  // keep reading committed `steps` so they don't refire on every shift.
  // Commit happens once on pointer-up.
  const [draft, setDraft] = useState<Step[] | null>(null);
  const displaySteps = draft ?? steps;

  // Only steps with active filters drive queries — adding an empty step
  // doesn't trigger a refetch. Segment-ref resolution happens on the
  // data server, so authored criteria flows straight through.
  const authoredCriteria = useMemo<Criteria>(
    () => ({ steps: steps.filter(isActiveStep) }),
    [steps],
  );

  // Segment id -> row lookup, used by the cascade panel to render
  // segment refs as "Segment: <name>" and to mirror the expansion's
  // drop-on-missing behaviour so the panel's steps align 1:1 with the
  // count-cascade response.
  const segmentsById = useMemo(
    () => new globalThis.Map((allSegments ?? []).map((s) => [s.segmentId, s])),
    [allSegments],
  );
  const displayCriteriaSteps = useMemo(
    () =>
      authoredCriteria.steps.filter(
        (s) =>
          s.filter.kind !== "segment" ||
          (s.filter.segmentId != null && segmentsById.has(s.filter.segmentId)),
      ),
    [authoredCriteria.steps, segmentsById],
  );

  // Session-remembered across visits, like the segment selection itself.
  const [rememberedView, setView] = useRememberedState(orgSlug, "segments-view", "map");
  const view = rememberedView === "list" || rememberedView === "waterfall" ? rememberedView : "map";

  // Counts are always needed (shown in every view). View-specific queries
  // only fire when that view is active — no point hitting DuckDB for data
  // the user isn't looking at. keepPreviousData + staleTime:∞ means
  // revisiting a view after a criteria change shows the last result while
  // the new fetch lands, and a previously-visited view is instant from cache.
  const { data: counts, isPlaceholderData: countsStale } = useQuery({
    ...segmentCountsQuery(authoredCriteria, allSegments),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const {
    data: pointsBuffer,
    isPlaceholderData: pointsStale,
    isLoading: pointsLoading,
  } = useQuery({
    ...segmentPointsQuery(authoredCriteria, allSegments),
    enabled: !!activeSegmentDetail && view === "map",
    placeholderData: keepPreviousData,
  });
  const {
    data: sample,
    isPlaceholderData: sampleStale,
    isLoading: sampleLoading,
  } = useQuery({
    ...segmentSampleQuery(authoredCriteria, allSegments),
    enabled: !!activeSegmentDetail && view === "list",
    placeholderData: keepPreviousData,
  });
  const { data: cascade, isPlaceholderData: cascadeStale } = useQuery({
    ...segmentCascadeQuery(authoredCriteria, allSegments),
    enabled: !!activeSegmentDetail && view === "waterfall",
    placeholderData: keepPreviousData,
  });

  const activeViewStale =
    view === "map" ? pointsStale : view === "list" ? sampleStale : cascadeStale;
  const stale = countsStale || activeViewStale;

  // Stable refs — written during render so each update is synchronous with
  // the stale→false transition. Each ref only updates when its view is active
  // so switching views doesn't overwrite cached data with undefined.
  const stableCountsRef = useRef<typeof counts>(undefined);
  if (!stale) stableCountsRef.current = counts;

  const stablePointsRef = useRef<typeof pointsBuffer>(undefined);
  if (!stale && view === "map") stablePointsRef.current = pointsBuffer ?? stablePointsRef.current;

  const stablePersonsRef = useRef<NonNullable<typeof sample>["persons"]>([]);
  if (!stale && view === "list")
    stablePersonsRef.current = sample?.persons ?? stablePersonsRef.current;

  const stableCascadeRef = useRef<typeof cascade>(undefined);
  if (!stale && view === "waterfall")
    stableCascadeRef.current = cascade ?? stableCascadeRef.current;

  const stableCriteriaStepsRef = useRef<Step[]>([]);
  if (!stale && view === "waterfall") stableCriteriaStepsRef.current = displayCriteriaSteps;

  // Optimistic update: write Criteria into both the detail cache and the
  // list cache. The list carries criteria for every org segment so the
  // segment-ref filter editor can resolve cross-references; without
  // syncing the list, edits to X show up in X's own queries but referrers
  // (Y → Segment: X) keep expanding against the stale list copy until a
  // refetch lands. `updatedAt` is patched alongside criteria — referrers'
  // derived-count keys hash it via `segmentRefsVersion`. The optimistic
  // client-clock value is replaced by the server's on success, so a later
  // list refetch leaves the version stable.
  const updateCriteriaMutation = useMutation({
    mutationFn: (input: { segmentId: string; criteria: Criteria }) =>
      client.segments.updateCriteria({ segmentId: input.segmentId, criteria: input.criteria }),
    onMutate: async ({ segmentId: id, criteria }) => {
      await queryClient.cancelQueries({ queryKey: ["segment", id] });
      await queryClient.cancelQueries({ queryKey: ["segments"] });
      const previousDetail = queryClient.getQueryData(["segment", id]);
      const previousList = queryClient.getQueryData(["segments"]);
      patchSegmentCaches(id, { criteria, updatedAt: new Date() });
      return { previousDetail, previousList };
    },
    onSuccess: ({ updatedAt }, { segmentId: id }) => {
      patchSegmentCaches(id, { updatedAt });
    },
    onError: (e, { segmentId: id }, ctx) => {
      console.error("segments.updateCriteria failed", e);
      notify.error(e.message);
      if (ctx?.previousDetail) queryClient.setQueryData(["segment", id], ctx.previousDetail);
      if (ctx?.previousList) queryClient.setQueryData(["segments"], ctx.previousList);
    },
  });

  function patchSegmentCaches(id: string, patch: { criteria?: Criteria; updatedAt: Date }) {
    queryClient.setQueryData(["segment", id], (old: { criteria: unknown } | null | undefined) =>
      old ? { ...old, ...patch } : old,
    );
    queryClient.setQueryData(
      ["segments"],
      (old: ReadonlyArray<{ segmentId: string; criteria: unknown }> | undefined) =>
        old?.map((s) => (s.segmentId === id ? { ...s, ...patch } : s)),
    );
  }

  const commit = (nextSteps: Step[]) => {
    updateCriteriaMutation.mutate({ segmentId, criteria: { steps: nextSteps } });
  };
  // If the first step ends up as `add` (after a delete or reorder), coerce
  // it to `narrow` — first-step add is semantically equivalent to narrow but
  // would read oddly in the UI.
  const coerceFirstStep = (s: Step[]): Step[] => {
    if (s[0]?.verb !== "add") return s;
    return [{ ...s[0], verb: "narrow" }, ...s.slice(1)];
  };

  const updateStep = (idx: number, next: Step) =>
    commit(steps.map((s, i) => (i === idx ? next : s)));
  const removeStep = (idx: number) => commit(coerceFirstStep(steps.filter((_, i) => i !== idx)));
  const addStep = (verb: Verb, def: FilterDef) =>
    commit([...steps, { id: crypto.randomUUID(), verb, filter: emptyFilterFor(def) }]);

  const handleDragEnd = () => {
    if (!draft) return;
    commit(coerceFirstStep(draft));
    setDraft(null);
  };

  // Auto-scroll the step list to the bottom when a step is added so the
  // newly-added step is always visible even when the list overflows.
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  // Track per-segment so tabbing between segments doesn't read "count grew."
  const prevStepsRef = useRef<{ segmentId: string; length: number } | null>(null);
  useEffect(() => {
    // While the segment itself is loading, steps going 0→N is data arrival,
    // not a user add — don't record a baseline or scroll.
    if (!activeSegmentDetail) return;
    const prev = prevStepsRef.current;
    if (
      prev &&
      prev.segmentId === segmentId &&
      steps.length > prev.length &&
      stepsContainerRef.current
    ) {
      stepsContainerRef.current.scrollTo({
        top: stepsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevStepsRef.current = { segmentId, length: steps.length };
  }, [activeSegmentDetail, segmentId, steps.length]);

  return (
    <div className="flex gap-4 h-full">
      <div
        ref={stepsContainerRef}
        className={cn(
          "w-86 shrink-0 flex flex-col gap-3 overflow-y-auto",
          // Catalog still in flight (hydration beat the streamed defs on a
          // slow-SSR refresh): hold the panel invisible so def-less cards
          // never paint, then fade the completed panel in.
          catalogLoading ? "opacity-0" : "opacity-100 transition-opacity duration-100",
        )}
      >
        {activeSegmentDetail ? (
          <>
            <div
              className={cn(
                "sticky top-0 z-10 bg-background",
                "before:content-[''] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-background before:-z-10",
                "after:content-[''] after:absolute after:inset-x-0 after:top-full after:h-2 after:bg-background after:-z-10",
              )}
            >
              <AddStepMenu sections={sections} isFirstStep={steps.length === 0} onAdd={addStep} />
            </div>
            {/* Mount the cards only once the catalog is resolved: cards that
                mount def-less and then grow give motion a stale position
                measurement to tween from — an animated reflow the fade can't
                hide. A fresh mount of the completed cards animates nothing. */}
            {!catalogLoading && (
              <Reorder.Group
                axis="y"
                values={displaySteps}
                onReorder={setDraft}
                as="div"
                className="flex flex-col gap-3"
              >
                {displaySteps.map((step, idx) => {
                  const serverIdx = steps.findIndex((s) => s.id === step.id);
                  return (
                    <ReorderStepRow
                      key={step.id}
                      number={idx + 1}
                      step={step}
                      onChange={(next) => updateStep(serverIdx, { ...step, filter: next })}
                      onRemove={() => removeStep(serverIdx)}
                      onDragEnd={handleDragEnd}
                      currentSegmentId={segmentId}
                      allSegments={allSegments ?? []}
                    />
                  );
                })}
              </Reorder.Group>
            )}
          </>
        ) : null}
      </div>
      <div className="flex-1 min-w-0 flex h-full min-h-0 flex-col gap-3">
        <div className="relative flex-1 min-h-0">
          <div className={cn("h-full min-h-0 transition-opacity", stale ? "opacity-50" : null)}>
            {view === "map" ? (
              <Map
                className="h-full"
                points={stablePointsRef.current}
                loading={pointsLoading && !stablePointsRef.current}
              />
            ) : view === "list" ? (
              <SamplePanel
                persons={stablePersonsRef.current}
                firstLoad={sampleLoading && stablePersonsRef.current.length === 0}
              />
            ) : (
              <WaterfallPanel
                steps={stableCascadeRef.current?.steps ?? []}
                criteriaSteps={stableCriteriaStepsRef.current}
                segmentsById={segmentsById}
                firstLoad={stableCascadeRef.current === undefined}
              />
            )}
          </div>
          <div className="absolute left-3 bottom-3 z-50">
            <ToggleGroup
              variant="outline"
              value={[view]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "map" || next === "list" || next === "waterfall") setView(next);
              }}
              className="bg-background"
            >
              <ToggleGroupItem value="map">Map</ToggleGroupItem>
              <ToggleGroupItem value="list">List</ToggleGroupItem>
              <ToggleGroupItem value="waterfall">Steps</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <CountsPanel counts={stableCountsRef.current} stale={stale} />
      </div>
    </div>
  );
}

function SamplePanel({
  persons,
  firstLoad,
}: {
  persons: NonNullable<Awaited<ReturnType<typeof client.segments.sample>>>["persons"];
  firstLoad: boolean;
}) {
  if (firstLoad) {
    return <div className="h-full rounded-lg border border-border bg-card" />;
  }
  return (
    <div className="h-full rounded-lg border border-border bg-card px-4 pb-2 pt-2">
      <Table
        className="table-fixed"
        containerClassName="h-full overflow-y-auto overflow-x-clip pb-10.5"
      >
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:h-8">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>City</TableHead>
            <TableHead className="w-16">State</TableHead>
            <TableHead className="w-20">Zip</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {persons.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No people match this segment.
              </TableCell>
            </TableRow>
          ) : (
            persons.map((p, idx) => (
              <TableRow key={idx}>
                <TableCell className="truncate px-2">
                  {toTitleCase(
                    [p.firstName, p.middleName, p.lastName, p.nameSuffix]
                      .filter(Boolean)
                      .join(" ") || "—",
                  )}
                </TableCell>
                <TableCell className="truncate px-2">
                  {[toTitleCase(p.addressLine1), p.addressLine2].filter(Boolean).join(", ") || "—"}
                </TableCell>
                <TableCell className="truncate px-2">{toTitleCase(p.city) ?? "—"}</TableCell>
                <TableCell className="truncate px-2">{p.state ?? "—"}</TableCell>
                <TableCell className="truncate px-2">{p.zip5 ?? "—"}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function WaterfallPanel({
  steps,
  criteriaSteps,
  segmentsById,
  firstLoad,
}: {
  steps: CascadeStep[];
  criteriaSteps: Step[];
  segmentsById: ReadonlyMap<string, { name: string }>;
  firstLoad: boolean;
}) {
  const { definitionFor } = useFilterCatalog();
  const [anchor, setAnchor] = useState(0);
  const effectiveAnchor = Math.min(anchor, steps.length - 1);
  const anchorCount = steps[effectiveAnchor]?.count ?? 0;

  if (firstLoad) {
    return <div className="h-full rounded-lg border border-border bg-card" />;
  }
  return (
    <div className="h-full rounded-lg border border-border bg-card px-2 pb-2 pt-1.5">
      <Table
        containerClassName="h-full overflow-y-auto overflow-x-clip pb-10"
        className="border-separate border-spacing-y-0.5"
      >
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:h-8">
          <TableRow>
            <TableHead className="!pl-2">Step</TableHead>
            <TableHead className="w-20">Type</TableHead>
            <TableHead className="w-26 text-right">Count</TableHead>
            <TableHead className="w-26 text-right">Delta</TableHead>
            <TableHead className="w-44">Fraction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="relative -top-[2px]">
          {steps.map((step, i) => {
            const criteriaStep = criteriaSteps[i - 1];
            const verb = criteriaStep?.verb;
            const verbMeta = verb ? VERB_META[verb] : null;
            const stepLabel = (() => {
              if (!criteriaStep) return null;
              const f = criteriaStep.filter;
              if (f.kind === "all") return "Everyone";
              if (f.kind === "segment") {
                const name = f.segmentId ? segmentsById.get(f.segmentId)?.name : null;
                return name ? `Segment: ${name}` : "Segment";
              }
              return definitionFor(filterKey(f))?.label ?? null;
            })();
            const label = i === 0 ? "All" : (stepLabel ?? "—");
            const isAnchor = i === effectiveAnchor;
            const above = i < effectiveAnchor;
            const prevCount = steps[i - 1]?.count ?? 0;
            const delta = i === 0 || above || isAnchor ? null : step.count - prevCount;
            const pct =
              !above && anchorCount > 0 ? Math.round((step.count / anchorCount) * 100) : null;
            return (
              <TableRow
                key={i}
                onClick={() => setAnchor(i)}
                className={cn(
                  "cursor-pointer [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md",
                  isAnchor ? "[&>td]:bg-accent/50" : "hover:[&>td]:bg-accent/50",
                )}
              >
                <TableCell className="!pl-2 px-2 truncate">{label}</TableCell>
                <TableCell className="px-2">
                  {verbMeta ? (
                    <Badge color={verbMeta.color}>{verbMeta.label}</Badge>
                  ) : (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                      Start
                    </span>
                  )}
                </TableCell>
                <TableCell className="px-2 text-right tabular-nums">
                  {step.count.toLocaleString()}
                </TableCell>
                <TableCell
                  className={cn(
                    "px-2 text-right tabular-nums",
                    delta === null && "text-muted-foreground",
                    delta !== null && verbMeta && "badge-fg",
                  )}
                  style={delta !== null && verbMeta ? tintStyle(verbMeta.color) : undefined}
                >
                  {delta !== null
                    ? delta.toLocaleString(undefined, { signDisplay: "exceptZero" })
                    : "—"}
                </TableCell>
                <TableCell className="px-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      {pct !== null && (
                        <div
                          className="h-full rounded-full bg-foreground/30"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      )}
                    </div>
                    <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                      {pct !== null ? `${pct}%` : "—"}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function CountsPanel({
  counts,
  stale,
}: {
  counts:
    | {
        personCount: number;
        doorCount: number;
        buildingCount: number;
      }
    | undefined;
  stale: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div
        className={cn(
          // Dim while mid-edit/save so it's clear the numbers reflect the
          // last saved query. Border + background stay solid.
          "grid grid-cols-3 gap-4 transition-opacity",
          stale ? "opacity-30" : null,
        )}
      >
        <Stat label="People" value={counts?.personCount} />
        <Stat label="Doors" value={counts?.doorCount} />
        <Stat label="Buildings" value={counts?.buildingCount} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex flex-col">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-xl tracking-tight tabular-nums">
        {value == null ? "—" : value.toLocaleString()}
      </span>
    </div>
  );
}

function ReorderStepRow({
  onDragEnd,
  ...props
}: ComponentProps<typeof StepRow> & { onDragEnd?: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={props.step}
      dragListener={false}
      dragControls={controls}
      as="div"
      onDragEnd={onDragEnd}
      // Animate reorder (position) but not size, so a filter's height change
      // (e.g. switching a canvass-response question) is instant, not animated.
      layout="position"
      transition={{ layout: { type: "tween", duration: 0.15, ease: "easeOut" } }}
      dragTransition={{ bounceStiffness: 10000, bounceDamping: 500, power: 0 }}
    >
      <StepRow {...props} dragControls={controls} />
    </Reorder.Item>
  );
}

function StepRow({
  number,
  step,
  onChange,
  onRemove,
  dragControls,
  currentSegmentId,
  allSegments,
}: {
  number: number;
  step: Step;
  onChange: (next: Filter) => void;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
  currentSegmentId: string;
  allSegments: ReadonlyArray<{
    segmentId: string;
    name: string;
    criteria: unknown;
    isArchived: boolean;
  }>;
}) {
  const { definitionFor } = useFilterCatalog();
  const { filter, verb } = step;
  const { color, label: verbLabel } = VERB_META[verb];
  const def = filter.kind === "all" ? undefined : definitionFor(filterKey(filter));
  const label = filter.kind === "all" ? "Everyone" : (def?.label ?? "—");

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div
        className={cn(
          filter.kind === "all" ? "mb-0" : "mb-3",
          "flex items-center justify-between gap-2",
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground shrink-0"
            onPointerDown={(e) => dragControls?.start(e)}
            aria-label="Drag to reorder"
          >
            <Icon name="grip-vertical" className="size-3.5" />
          </button>
          <span className="text-sm truncate">
            <span className="text-muted-foreground pr-2 tabular-nums">{number}</span>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge color={color}>{verbLabel}</Badge>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={onRemove}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Remove step"
          >
            <Icon name="x" className="size-4" />
          </Button>
        </div>
      </div>
      <FilterValueEditor
        filter={filter}
        def={def}
        onChange={onChange}
        currentSegmentId={currentSegmentId}
        allSegments={allSegments}
      />
    </div>
  );
}
