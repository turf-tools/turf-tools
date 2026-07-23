import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Reorder, useDragControls } from "motion/react";
import { toast } from "sonner";
import {
  Calendar as CalendarIcon,
  ChevronDown,
  Filter as FilterIcon,
  GripVertical,
  Minus,
  Plus,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Calendar } from "~/components/calendar";
import { Input } from "~/components/input";
import { Map } from "~/components/map";
import { NumberInput } from "~/components/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { Toggle } from "~/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import {
  type AddressFilter,
  type AgeRangeFilter,
  type CanvassResponseFilter,
  type CanvassOutcomeFilter,
  type DateRangeFilter,
  emptyFilterFor,
  type EnumFilter,
  type Filter,
  type FilterDef,
  filterKey,
  isActiveStep,
  type Criteria,
  type SegmentFilter,
  type Step,
  type NumberRangeFilter,
  type TextFilter,
  type TextMultiFilter,
  type Verb,
  type VotingHistoryCountFilter,
  type VotingHistoryDetailFilter,
  VERB_META,
} from "~/lib/filters";
import {
  segmentCascadeQuery,
  segmentCountsQuery,
  segmentDetailQuery,
  segmentPointsQuery,
  segmentSampleQuery,
  segmentsListQuery,
} from "~/lib/queries/segments";
import { electionsQuery } from "~/lib/queries/elections";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { useFilterCatalog } from "~/lib/manifest";
import { findCyclicSegmentIds, type SegmentLike } from "~/lib/segment-refs";
import type { CascadeStep } from "~/rpc/web/segments";
import { cn, toTitleCase } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/segments/$segmentId")({
  loader: async ({ context: { queryClient }, params: { orgSlug, segmentId } }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    const exists = segments.some((s) => s.segmentId === segmentId);
    if (!exists) {
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
  const { segmentId } = Route.useParams();
  const { sections } = useFilterCatalog();

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

  const [view, setView] = useState<"map" | "list" | "waterfall">("map");

  // Counts are always needed (shown in every view). View-specific queries
  // only fire when that view is active — no point hitting DuckDB for data
  // the user isn't looking at. keepPreviousData + staleTime:∞ means
  // revisiting a view after a criteria change shows the last result while
  // the new fetch lands, and a previously-visited view is instant from cache.
  const { data: counts, isPlaceholderData: countsStale } = useQuery({
    ...segmentCountsQuery(authoredCriteria),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const {
    data: pointsBuffer,
    isPlaceholderData: pointsStale,
    isLoading: pointsLoading,
  } = useQuery({
    ...segmentPointsQuery(authoredCriteria),
    enabled: !!activeSegmentDetail && view === "map",
    placeholderData: keepPreviousData,
  });
  const {
    data: sample,
    isPlaceholderData: sampleStale,
    isLoading: sampleLoading,
  } = useQuery({
    ...segmentSampleQuery(authoredCriteria),
    enabled: !!activeSegmentDetail && view === "list",
    placeholderData: keepPreviousData,
  });
  const { data: cascade, isPlaceholderData: cascadeStale } = useQuery({
    ...segmentCascadeQuery(authoredCriteria),
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
  // refetch lands.
  const updateCriteriaMutation = useMutation({
    mutationFn: (input: { segmentId: string; criteria: Criteria }) =>
      client.segments.updateCriteria({ segmentId: input.segmentId, criteria: input.criteria }),
    onMutate: async ({ segmentId: id, criteria }) => {
      await queryClient.cancelQueries({ queryKey: ["segment", id] });
      await queryClient.cancelQueries({ queryKey: ["segments"] });
      const previousDetail = queryClient.getQueryData(["segment", id]);
      const previousList = queryClient.getQueryData(["segments"]);
      queryClient.setQueryData(["segment", id], (old: { criteria: unknown } | null | undefined) =>
        old ? { ...old, criteria } : old,
      );
      queryClient.setQueryData(
        ["segments"],
        (old: ReadonlyArray<{ segmentId: string; criteria: unknown }> | undefined) =>
          old?.map((s) => (s.segmentId === id ? { ...s, criteria } : s)),
      );
      return { previousDetail, previousList };
    },
    onError: (e, { segmentId: id }, ctx) => {
      console.error("segments.updateCriteria failed", e);
      toast.error(e.message);
      if (ctx?.previousDetail) queryClient.setQueryData(["segment", id], ctx.previousDetail);
      if (ctx?.previousList) queryClient.setQueryData(["segments"], ctx.previousList);
    },
  });

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
  const prevStepsLengthRef = useRef(steps.length);
  useEffect(() => {
    if (steps.length > prevStepsLengthRef.current && stepsContainerRef.current) {
      stepsContainerRef.current.scrollTo({
        top: stepsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevStepsLengthRef.current = steps.length;
  }, [steps.length]);

  return (
    <div className="flex gap-4 h-full">
      <div ref={stepsContainerRef} className="w-86 shrink-0 flex flex-col gap-3 overflow-y-auto">
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
                    <span
                      className="rounded px-1.5 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: `${verbMeta.color}22`, color: verbMeta.color }}
                    >
                      {verbMeta.label}
                    </span>
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
                  )}
                  style={{ color: delta !== null ? (verbMeta?.color ?? "inherit") : undefined }}
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
  allSegments: ReadonlyArray<{ segmentId: string; name: string; criteria: unknown }>;
}) {
  const { definitionFor } = useFilterCatalog();
  const { filter, verb } = step;
  const { color, label: verbLabel } = VERB_META[verb];
  const def =
    filter.kind === "all"
      ? { kind: "all" as const, key: "all", label: "Everyone" }
      : definitionFor(filterKey(filter));

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
            <GripVertical className="size-3.5" />
          </button>
          <span className="text-sm truncate">
            <span className="text-muted-foreground pr-2 tabular-nums">{number}</span>
            {def?.label ?? "—"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${color}22`, color }}
          >
            {verbLabel}
          </span>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={onRemove}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Remove step"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {filter.kind === "enum" && def?.kind === "enum" ? (
        <EnumFilterEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "age-range" && def?.kind === "age-range" ? (
        <AgeRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "text" && def?.kind === "text" ? (
        <TextFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "text-multi" && def?.kind === "text-multi" ? (
        <TextMultiFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "date-range" && def?.kind === "date-range" ? (
        <DateRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "voting-history-count" && def?.kind === "voting-history-count" ? (
        <VotingHistoryCountEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "voting-history-detail" && def?.kind === "voting-history-detail" ? (
        <VotingHistoryDetailEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "address" && def?.kind === "address" ? (
        <AddressFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "number-range" && def?.kind === "number-range" ? (
        <NumberRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "canvass-outcome" && def?.kind === "canvass-outcome" ? (
        <CanvassOutcomeEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "canvass-response" && def?.kind === "canvass-response" ? (
        <CanvassResponseEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "segment" && def?.kind === "segment" ? (
        <SegmentFilterEditor
          filter={filter}
          onChange={onChange}
          currentSegmentId={currentSegmentId}
          allSegments={allSegments}
        />
      ) : null}
    </div>
  );
}

function TextFilterEditor({
  filter,
  onChange,
}: {
  filter: TextFilter;
  onChange: (next: Filter) => void;
}) {
  // Local input state so typing doesn't fire onChange per keystroke
  // (which would refetch on every character). Committed value lives in
  // the segment cache; sync down on prop change, commit up on blur/Enter.
  const [local, setLocal] = useState(filter.value);
  useEffect(() => setLocal(filter.value), [filter.value]);
  const commit = () => {
    if (local !== filter.value) onChange({ ...filter, value: local });
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Contains</span>
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 text-sm"
        placeholder="any substring"
      />
    </div>
  );
}

// Per-key normalizer for text-multi values. Run on each token at commit
// time so the canonical form is what gets stored and queried. Anything
// the normalizer doesn't recognize passes through unchanged so the user
// can see the bad value and correct it.
const NORMALIZERS: Record<string, (v: string) => string> = {
  // NYC precincts canonicalize as `AA-EEE` (zero-padded AD, dash, zero-padded ED).
  // Accept compact 5-digit input as a shortcut.
  precinct: (v) => (/^\d{5}$/.test(v) ? `${v.slice(0, 2)}-${v.slice(2)}` : v),
};

function TextMultiFilterEditor({
  filter,
  onChange,
}: {
  filter: TextMultiFilter;
  onChange: (next: Filter) => void;
}) {
  // Local input state — same commit-on-blur/Enter pattern as TextFilterEditor.
  // Parse on commit: split on comma, trim, normalize, drop empties, dedupe
  // (preserve order).
  const [local, setLocal] = useState(filter.values.join(", "));
  useEffect(() => setLocal(filter.values.join(", ")), [filter.values]);
  const normalize = NORMALIZERS[filter.key] ?? ((v: string) => v);
  const commit = () => {
    const tokens = local
      .split(",")
      .map((t) => normalize(t.trim()))
      .filter((t) => t.length > 0);
    const next = Array.from(new Set(tokens));
    const same =
      next.length === filter.values.length && next.every((v, i) => v === filter.values[i]);
    if (!same) onChange({ ...filter, values: next });
    else setLocal(next.join(", "));
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Equals</span>
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 text-sm"
        placeholder="single or comma-separated"
      />
    </div>
  );
}

function EnumFilterEditor({
  filter,
  def,
  onChange,
}: {
  filter: EnumFilter;
  def: Extract<FilterDef, { kind: "enum" }>;
  onChange: (next: Filter) => void;
}) {
  const toggle = (value: string) => {
    const next = filter.values.includes(value)
      ? filter.values.filter((v) => v !== value)
      : [...filter.values, value];
    onChange({ ...filter, values: next });
  };
  // Render selected values even when the option set no longer carries them
  // (custom-field re-derives and manifest drift across versions both retire
  // values) — a stale selection stays visible and untogglable-away instead of
  // silently constraining the query. Once untoggled, it disappears for good.
  const options: Array<{ value: string; label?: string }> = [
    ...def.values,
    ...filter.values
      .filter((v) => !def.values.some((o) => o.value === v))
      .map((v) => ({ value: v })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((v) => (
        <Toggle
          key={v.value}
          size="sm"
          variant="outline"
          pressed={filter.values.includes(v.value)}
          onPressedChange={() => toggle(v.value)}
          className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
        >
          {v.label ?? v.value}
        </Toggle>
      ))}
    </div>
  );
}

function CanvassOutcomeEditor({
  filter,
  def,
  onChange,
}: {
  filter: CanvassOutcomeFilter;
  def: Extract<FilterDef, { kind: "canvass-outcome" }>;
  onChange: (next: Filter) => void;
}) {
  const toggle = (value: string) => {
    const next = filter.outcomes.includes(value)
      ? filter.outcomes.filter((v) => v !== value)
      : [...filter.outcomes, value];
    onChange({ ...filter, outcomes: next });
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {def.values.map((v) => (
        <Toggle
          key={v.value}
          size="sm"
          variant="outline"
          pressed={filter.outcomes.includes(v.value)}
          onPressedChange={() => toggle(v.value)}
          className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
        >
          {v.label ?? v.value}
        </Toggle>
      ))}
    </div>
  );
}

function CanvassResponseEditor({
  filter,
  onChange,
}: {
  filter: CanvassResponseFilter;
  onChange: (next: Filter) => void;
}) {
  // Names + options in one query, so the dropdown and toggles render off the
  // same data (no per-question fetch).
  const { data: questions } = useQuery(questionsWithOptionsQuery());

  // Mirror the selection locally so the options swap in the same frame the
  // dropdown closes, not a tick later when the criteria write notifies.
  const [localQuestionId, setLocalQuestionId] = useState(filter.questionId);
  useEffect(() => setLocalQuestionId(filter.questionId), [filter.questionId]);
  const [showArchived, setShowArchived] = useState(false);
  const [showArchivedQuestions, setShowArchivedQuestions] = useState(false);

  const selected = questions?.find((q) => q.questionId === localQuestionId);
  const triggerLabel = selected
    ? selected.archived
      ? `${selected.name} (archived)`
      : selected.name
    : localQuestionId && questions
      ? "(deleted)"
      : "Select question…";
  const activeQuestions = questions?.filter((q) => !q.archived) ?? [];
  const archivedQuestions = questions?.filter((q) => q.archived) ?? [];
  // Keep the selected question in the menu even if it's archived (so a saved
  // filter's question doesn't vanish on load); "Show archived" reveals the rest.
  const visibleArchivedQuestions = showArchivedQuestions
    ? archivedQuestions
    : archivedQuestions.filter((q) => q.questionId === localQuestionId);
  const archivedQuestionsHidden = archivedQuestions.some((q) => q.questionId !== localQuestionId);
  const options = selected?.options ?? [];
  // Show active options; keep a referenced archived option visible (so it can
  // be removed), and reveal the rest when "Show archived" is on.
  const visibleOptions = options.filter(
    (o) => showArchived || !o.archived || filter.optionIds.includes(o.responseOptionId),
  );
  // Only offer the toggle when there's a hidden archived option to reveal.
  const archivedHidden = options.some(
    (o) => o.archived && !filter.optionIds.includes(o.responseOptionId),
  );

  const toggle = (optionId: string) => {
    const next = filter.optionIds.includes(optionId)
      ? filter.optionIds.filter((v) => v !== optionId)
      : [...filter.optionIds, optionId];
    onChange({ ...filter, optionIds: next });
  };

  // Switching questions clears the now-irrelevant option set.
  const selectQuestion = (questionId: string) => {
    setLocalQuestionId(questionId);
    setShowArchived(false);
    onChange({ ...filter, questionId, optionIds: [] });
  };

  return (
    <div className="flex flex-col gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" className="w-full justify-between font-normal" />}
        >
          <span className={cn("truncate", !selected ? "text-muted-foreground" : null)}>
            {triggerLabel}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-48 max-h-[291px] overflow-y-auto">
          {!questions || questions.length === 0 ? (
            <DropdownMenuItem disabled>No questions available</DropdownMenuItem>
          ) : (
            <>
              {activeQuestions.map((q) => (
                <DropdownMenuItem key={q.questionId} onClick={() => selectQuestion(q.questionId)}>
                  {q.name}
                </DropdownMenuItem>
              ))}
              {visibleArchivedQuestions.map((q) => (
                <DropdownMenuItem key={q.questionId} onClick={() => selectQuestion(q.questionId)}>
                  {q.name}
                  {" (archived)"}
                </DropdownMenuItem>
              ))}
              {archivedQuestionsHidden ? (
                <DropdownMenuItem
                  className="text-muted-foreground"
                  closeOnClick={false}
                  onClick={() => setShowArchivedQuestions((v) => !v)}
                >
                  {showArchivedQuestions ? "Hide archived" : "Show archived"}
                </DropdownMenuItem>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {localQuestionId && (visibleOptions.length > 0 || archivedHidden) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleOptions.map((o) => (
            <Toggle
              key={o.responseOptionId}
              size="sm"
              variant="outline"
              pressed={filter.optionIds.includes(o.responseOptionId)}
              onPressedChange={() => toggle(o.responseOptionId)}
              className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
            >
              {o.text.trim() ? (
                o.text
              ) : (
                <span className="italic text-muted-foreground">Empty option</span>
              )}
              {o.archived ? " (archived)" : null}
            </Toggle>
          ))}
          {archivedHidden ? (
            <Button
              variant="outline"
              size="sm"
              className="text-[0.8rem] text-muted-foreground"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AgeRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: AgeRangeFilter;
  onChange: (next: Filter) => void;
}) {
  // Same commit-on-blur/Enter pattern as text.
  const [localMin, setLocalMin] = useState(filter.min == null ? "" : String(filter.min));
  const [localMax, setLocalMax] = useState(filter.max == null ? "" : String(filter.max));
  useEffect(() => setLocalMin(filter.min == null ? "" : String(filter.min)), [filter.min]);
  useEffect(() => setLocalMax(filter.max == null ? "" : String(filter.max)), [filter.max]);
  const commit = () => {
    const min = localMin === "" ? null : Number(localMin);
    const max = localMax === "" ? null : Number(localMax);
    if (min !== filter.min || max !== filter.max) onChange({ ...filter, min, max });
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <NumberInput
        value={localMin}
        onChange={setLocalMin}
        onCommit={commit}
        min={0}
        max={120}
        className="h-7 w-16 px-2"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <NumberInput
        value={localMax}
        onChange={setLocalMax}
        onCommit={commit}
        min={0}
        max={120}
        className="h-7 w-16 px-2"
        placeholder="max"
      />
      <span className="text-muted-foreground">years</span>
    </div>
  );
}

// ISO 8601 YYYY-MM-DD ↔ Date helpers. Treat the string as a *local* date —
// date-only values are inherently timezone-naïve. Round-trip stays consistent
// with what react-day-picker shows the user.
function isoToDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}
function dateToIso(d: Date | undefined): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatHuman(s: string | null): string {
  const d = isoToDate(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function DatePickerInput({
  value,
  onChange,
  placeholder,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="h-7 px-2 font-normal">
              <CalendarIcon className="size-3.5" />
              <span className={cn(!value && "text-muted-foreground")}>
                {value ? formatHuman(value) : placeholder}
              </span>
            </Button>
          }
        />
        <PopoverContent
          align="start"
          className="w-auto p-0"
          // Skip the fade/zoom animation so the close doesn't visually
          // overlap the map refetch that follows a date selection.
          style={{ animationDuration: "0s", transitionDuration: "0s" }}
        >
          <Calendar
            mode="single"
            selected={isoToDate(value)}
            onSelect={(d) => {
              onChange(dateToIso(d));
              setOpen(false);
            }}
            captionLayout="dropdown"
          />
        </PopoverContent>
      </Popover>
      {value ? (
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onChange(null)}
          aria-label="Clear date"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function AddressFilterEditor({
  filter,
  onChange,
}: {
  filter: AddressFilter;
  onChange: (next: Filter) => void;
}) {
  // Commit-on-blur for each sub-field — same pattern as TextFilterEditor.
  // All fields optional; each non-empty one ANDs into the WHERE clause.
  type SubKey = "line1" | "city" | "state" | "zip";
  const subField = (key: SubKey, placeholder: string, width: string) => (
    <SubTextInput
      value={filter[key]}
      placeholder={placeholder}
      className={cn("h-7 px-2", width)}
      onCommit={(v) => {
        if (v !== filter[key]) onChange({ ...filter, [key]: v });
      }}
    />
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {subField("line1", "street", "w-full")}
      <div className="flex items-center gap-2">
        {subField("city", "city", "flex-1")}
        {subField("state", "state", "w-14")}
        {subField("zip", "zip", "w-20")}
      </div>
    </div>
  );
}

// Small local helper — text input with commit-on-blur/Enter.
function SubTextInput({
  value,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  placeholder: string;
  className?: string;
  onCommit: (next: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => onCommit(local);
  return (
    <Input
      value={local}
      placeholder={placeholder}
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function DateRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: DateRangeFilter;
  onChange: (next: Filter) => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Between</span>
        <DatePickerInput
          value={filter.min}
          onChange={(min) => onChange({ ...filter, min })}
          placeholder="any date"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">and</span>
        <DatePickerInput
          value={filter.max}
          onChange={(max) => onChange({ ...filter, max })}
          placeholder="any date"
        />
      </div>
    </div>
  );
}

function VotingHistoryCountEditor({
  filter,
  onChange,
}: {
  filter: VotingHistoryCountFilter;
  onChange: (next: Filter) => void;
}) {
  const [localCount, setLocalCount] = useState(String(filter.count));
  const [localWindow, setLocalWindow] = useState(String(filter.windowYears));
  useEffect(() => setLocalCount(String(filter.count)), [filter.count]);
  useEffect(() => setLocalWindow(String(filter.windowYears)), [filter.windowYears]);
  const commitCount = () => {
    const n = Number(localCount);
    if (Number.isFinite(n) && n !== filter.count) onChange({ ...filter, count: n });
  };
  const commitWindow = () => {
    const n = Number(localWindow);
    if (Number.isFinite(n) && n !== filter.windowYears) onChange({ ...filter, windowYears: n });
  };
  // Radio-style toggles: clicking an already-pressed item is a no-op (we
  // never want zero selected). Mirrors EnumFilterEditor styling so these
  // read as the same kind of choice control.
  const radioClass = "aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Voted in</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.comparator === "at_least"}
          onPressedChange={(p) => p && onChange({ ...filter, comparator: "at_least" })}
          className={radioClass}
        >
          At least
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.comparator === "exactly"}
          onPressedChange={(p) => p && onChange({ ...filter, comparator: "exactly" })}
          className={radioClass}
        >
          Exactly
        </Toggle>
        <NumberInput
          value={localCount}
          onChange={setLocalCount}
          onCommit={commitCount}
          min={0}
          className="h-7 w-12 px-2"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">of</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.type === "primary"}
          onPressedChange={(p) => p && onChange({ ...filter, type: "primary" })}
          className={radioClass}
        >
          Primaries
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.type === "general"}
          onPressedChange={(p) => p && onChange({ ...filter, type: "general" })}
          className={radioClass}
        >
          Generals
        </Toggle>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">in last</span>
        <NumberInput
          value={localWindow}
          onChange={setLocalWindow}
          onCommit={commitWindow}
          min={1}
          className="h-7 w-12 px-2"
        />
        <span className="text-muted-foreground">years</span>
      </div>
    </div>
  );
}

function NumberRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: NumberRangeFilter;
  onChange: (next: Filter) => void;
}) {
  // Same commit-on-blur/Enter pattern as text. Plain Inputs (not NumberInput,
  // which is digit-only) — scores are often decimals.
  const [localMin, setLocalMin] = useState(filter.min == null ? "" : String(filter.min));
  const [localMax, setLocalMax] = useState(filter.max == null ? "" : String(filter.max));
  useEffect(() => setLocalMin(filter.min == null ? "" : String(filter.min)), [filter.min]);
  useEffect(() => setLocalMax(filter.max == null ? "" : String(filter.max)), [filter.max]);
  const parse = (v: string) => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const commit = () => {
    const min = parse(localMin);
    const max = parse(localMax);
    if (min !== filter.min || max !== filter.max) onChange({ ...filter, min, max });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <Input
        value={localMin}
        onChange={(e) => setLocalMin(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-20 px-2"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <Input
        value={localMax}
        onChange={(e) => setLocalMax(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-20 px-2"
        placeholder="max"
      />
    </div>
  );
}

function VotingHistoryDetailEditor({
  filter,
  onChange,
}: {
  filter: VotingHistoryDetailFilter;
  onChange: (next: Filter) => void;
}) {
  // Elections are precomputed per active dataset (immutable, cached hard). Gate
  // on data so first load doesn't flash the empty state; the global spinner
  // covers the wait.
  const { data } = useQuery(electionsQuery());
  const toggle = (value: string) => {
    const next = filter.elections.includes(value)
      ? filter.elections.filter((v) => v !== value)
      : [...filter.elections, value];
    onChange({ ...filter, elections: next });
  };
  const radioClass = "aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground";
  if (!data) return null;
  if (data.elections.length === 0) {
    return <p className="text-sm text-muted-foreground">No elections in this dataset.</p>;
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Voted in</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.mode === "any"}
          onPressedChange={(p) => p && onChange({ ...filter, mode: "any" })}
          className={radioClass}
        >
          Any
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.mode === "all"}
          onPressedChange={(p) => p && onChange({ ...filter, mode: "all" })}
          className={radioClass}
        >
          All
        </Toggle>
        <span className="text-muted-foreground">of:</span>
      </div>
      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {data.elections.map((e) => (
          <Toggle
            key={e.value}
            size="sm"
            variant="outline"
            pressed={filter.elections.includes(e.value)}
            onPressedChange={() => toggle(e.value)}
            className={cn("h-7 w-full shrink-0 justify-start", radioClass)}
          >
            {e.label}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

function SegmentFilterEditor({
  filter,
  onChange,
  currentSegmentId,
  allSegments,
}: {
  filter: SegmentFilter;
  onChange: (next: Filter) => void;
  currentSegmentId: string;
  allSegments: ReadonlyArray<{ segmentId: string; name: string; criteria: unknown }>;
}) {
  // Segments that would form a cycle if selected — current segment plus
  // any that transitively reference it. The set is content-dependent;
  // re-derive whenever the segments list changes.
  const cyclic = useMemo<Set<string>>(() => {
    const entries: Array<[string, SegmentLike]> = allSegments.map((s) => [
      s.segmentId,
      { segmentId: s.segmentId, name: s.name, criteria: s.criteria as Criteria },
    ]);
    return findCyclicSegmentIds(currentSegmentId, new globalThis.Map(entries));
  }, [allSegments, currentSegmentId]);

  const selectable = [...allSegments]
    .filter((s) => !cyclic.has(s.segmentId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = filter.segmentId
    ? allSegments.find((s) => s.segmentId === filter.segmentId)
    : null;
  const triggerLabel = selected
    ? selected.name
    : filter.segmentId
      ? "(deleted)"
      : "Select segment…";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="w-full justify-between font-normal" />}
      >
        <span className={cn("truncate", !selected ? "text-muted-foreground" : null)}>
          {triggerLabel}
        </span>
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-48 max-h-[291px] overflow-y-auto">
        {selectable.length === 0 ? (
          <DropdownMenuItem disabled>No other segments available</DropdownMenuItem>
        ) : (
          selectable.map((s) => (
            <DropdownMenuItem
              key={s.segmentId}
              onClick={() => onChange({ ...filter, segmentId: s.segmentId })}
            >
              {s.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddStepMenu({
  sections,
  isFirstStep,
  onAdd,
}: {
  sections: ReadonlyArray<ReadonlyArray<FilterDef>>;
  isFirstStep: boolean;
  onAdd: (verb: Verb, def: FilterDef) => void;
}) {
  const verbIcons: Record<Verb, ReactNode> = {
    narrow: <FilterIcon className="size-3" strokeWidth={2.5} />,
    add: <Plus className="size-3" strokeWidth={2.5} />,
    remove: <Minus className="size-3" strokeWidth={2.5} />,
  };

  const allVerbs: Verb[] = ["narrow", "remove", "add"];

  return (
    <div className="flex gap-2">
      {allVerbs.map((verb) => {
        const { label } = VERB_META[verb];
        const disabled = isFirstStep && verb === "add"; // add only makes sense after a first step
        const visibleSections = sections;
        return (
          <div key={verb} className="flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    disabled={disabled}
                    className="w-full gap-1.5 text-sm"
                  />
                }
              >
                {verbIcons[verb]}
                {label}
              </DropdownMenuTrigger>
              <DropdownMenuContent align={verb === "add" ? "end" : "start"} className="min-w-48">
                {visibleSections.map((section, sectionIdx) => (
                  <Fragment key={sectionIdx}>
                    {sectionIdx > 0 ? <DropdownMenuSeparator /> : null}
                    {section.map((def) => (
                      <DropdownMenuItem key={def.key} onClick={() => onAdd(verb, def)}>
                        {def.kind === "segment" ? "Other Segment" : def.label}
                      </DropdownMenuItem>
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
