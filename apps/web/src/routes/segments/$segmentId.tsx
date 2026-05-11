import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Reorder, useDragControls } from "motion/react";
import { Filter as FilterIcon, GripVertical, Minus, Plus, X } from "lucide-react";
import React, {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "~/components/button";
import { Input } from "~/components/input";
import { Map } from "~/components/map";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { ToggleGroup, ToggleGroupItem } from "~/components/toggle-group";
import {
  type AgeRangeFilter,
  definitionFor,
  emptyFilterFor,
  type EnumFilter,
  type Filter,
  type FilterDef,
  filterKey,
  FILTERS,
  isActiveStep,
  type Pipeline,
  type Step,
  type TextFilter,
  type Verb,
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
import type { CascadeStep } from "~/rpc/segments";
import { cn, toTitleCase } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/segments/$segmentId")({
  loader: async ({ context: { queryClient }, params: { segmentId } }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    const exists = segments.some((s) => s.segmentId === segmentId);
    if (!exists) {
      throw redirect({ to: "/segments" });
    }
    await queryClient.fetchQuery(segmentDetailQuery(segmentId));
  },
  component: SegmentEditor,
});

function SegmentEditor() {
  const queryClient = useQueryClient();
  const { segmentId } = Route.useParams();

  // Loader prefetched, so this is a cache hit.
  const { data: activeSegmentDetail } = useQuery({
    ...segmentDetailQuery(segmentId),
  });

  const stepsRaw = (activeSegmentDetail?.criteria as Pipeline | null)?.steps ?? [];
  const stepsIdRef = useRef<string[]>([]);
  while (stepsIdRef.current.length < stepsRaw.length) stepsIdRef.current.push(crypto.randomUUID());
  const serverSteps = stepsRaw.map((s, i) => (s.id ? s : { ...s, id: stepsIdRef.current[i]! }));

  // During an active drag, the visual list reorders via `draft` — but
  // `effectivePipeline` keeps reading server steps so dependent queries
  // (count/sample/points) don't re-fire on every shift. Commit happens
  // once on pointer-up.
  const [draft, setDraft] = useState<Step[] | null>(null);
  const displaySteps = draft ?? serverSteps;
  const steps = serverSteps; // queries see committed state only

  // Only steps with active filters drive queries — adding an empty step
  // doesn't trigger a refetch.
  const effectivePipeline = useMemo<Pipeline>(
    () => ({ steps: steps.filter(isActiveStep) }),
    [steps],
  );

  const [view, setView] = useState<"map" | "list" | "waterfall">("map");

  // Counts are always needed (shown in every view). View-specific queries
  // only fire when that view is active — no point hitting DuckDB for data
  // the user isn't looking at. keepPreviousData + staleTime:∞ means
  // revisiting a view after a criteria change shows the last result while
  // the new fetch lands, and a previously-visited view is instant from cache.
  const { data: counts, isPlaceholderData: countsStale } = useQuery({
    ...segmentCountsQuery(effectivePipeline),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const {
    data: pointsBuffer,
    isPlaceholderData: pointsStale,
    isLoading: pointsLoading,
  } = useQuery({
    ...segmentPointsQuery(effectivePipeline),
    enabled: !!activeSegmentDetail && view === "map",
    placeholderData: keepPreviousData,
  });
  const {
    data: sample,
    isPlaceholderData: sampleStale,
    isLoading: sampleLoading,
  } = useQuery({
    ...segmentSampleQuery(effectivePipeline),
    enabled: !!activeSegmentDetail && view === "list",
    placeholderData: keepPreviousData,
  });
  const {
    data: cascade,
    isPlaceholderData: cascadeStale,
    isLoading: cascadeLoading,
  } = useQuery({
    ...segmentCascadeQuery(effectivePipeline),
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

  const stablePipelineStepsRef = useRef<Step[]>([]);
  if (!stale && view === "waterfall") stablePipelineStepsRef.current = effectivePipeline.steps;

  // Optimistic update: write Pipeline into the ["segment", id] cache.
  const updateCriteriaMutation = useMutation({
    mutationFn: (input: { segmentId: string; pipeline: Pipeline }) =>
      client.segments.updateCriteria({ segmentId: input.segmentId, criteria: input.pipeline }),
    onMutate: async ({ segmentId: id, pipeline }) => {
      await queryClient.cancelQueries({ queryKey: ["segment", id] });
      const previous = queryClient.getQueryData(["segment", id]);
      queryClient.setQueryData(["segment", id], (old: { criteria: unknown } | null | undefined) =>
        old ? { ...old, criteria: pipeline } : old,
      );
      return { previous };
    },
    onError: (e, { segmentId: id }, ctx) => {
      console.error("segments.updateCriteria failed", e);
      if (ctx?.previous) queryClient.setQueryData(["segment", id], ctx.previous);
    },
  });

  const commit = (nextSteps: Step[]) => {
    updateCriteriaMutation.mutate({ segmentId, pipeline: { steps: nextSteps } });
  };
  const updateStep = (idx: number, next: Step) =>
    commit(steps.map((s, i) => (i === idx ? next : s)));
  const removeStep = (idx: number) => {
    const next = steps.filter((_, i) => i !== idx);
    if (next[0]?.verb === "add") next[0] = { ...next[0], verb: "narrow" };
    commit(next);
  };
  const addStep = (verb: Verb, def: FilterDef) =>
    commit([...steps, { id: crypto.randomUUID(), verb, filter: emptyFilterFor(def) }]);

  const handleDragEnd = () => {
    if (!draft) return;
    const next = [...draft];
    if (next[0]?.verb === "add") next[0] = { ...next[0], verb: "narrow" };
    commit(next);
    setDraft(null);
  };

  // Auto-scroll the step list to the bottom when a step is added so the
  // newly-added step is always visible even when the list overflows.
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  const prevStepsLengthRef = useRef(serverSteps.length);
  useEffect(() => {
    if (serverSteps.length > prevStepsLengthRef.current && stepsContainerRef.current) {
      stepsContainerRef.current.scrollTo({
        top: stepsContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevStepsLengthRef.current = serverSteps.length;
  }, [serverSteps.length]);

  const availableDefs = FILTERS;

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
              <AddStepMenu defs={availableDefs} isFirstStep={steps.length === 0} onAdd={addStep} />
            </div>
            <Reorder.Group
              axis="y"
              values={displaySteps}
              onReorder={setDraft}
              as="div"
              className="flex flex-col gap-3"
            >
              {displaySteps.map((step, idx) => {
                const serverIdx = serverSteps.findIndex((s) => s.id === step.id);
                return (
                  <ReorderStepRow
                    key={step.id}
                    number={idx + 1}
                    step={step}
                    onChange={(next) => updateStep(serverIdx, { ...step, filter: next })}
                    onRemove={() => removeStep(serverIdx)}
                    onDragEnd={handleDragEnd}
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
                pipelineSteps={stablePipelineStepsRef.current}
                firstLoad={cascadeLoading && stableCascadeRef.current === undefined}
              />
            )}
          </div>
          <div className="absolute left-3 bottom-3 z-50 rounded-lg border border-border bg-background">
            <ToggleGroup
              value={[view]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "map" || next === "list" || next === "waterfall") setView(next);
              }}
            >
              <ToggleGroupItem value="map">Map</ToggleGroupItem>
              <div className="w-px self-stretch bg-border" />
              <ToggleGroupItem value="list">List</ToggleGroupItem>
              <div className="w-px self-stretch bg-border" />
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
                  {toTitleCase([p.firstName, p.lastName].filter(Boolean).join(" ") || "—")}
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
  pipelineSteps,
  firstLoad,
}: {
  steps: CascadeStep[];
  pipelineSteps: Step[];
  firstLoad: boolean;
}) {
  const [anchor, setAnchor] = useState(0);
  const effectiveAnchor = Math.min(anchor, steps.length - 1);
  const anchorCount = steps[effectiveAnchor]?.count ?? 0;

  if (firstLoad) {
    return <div className="h-full rounded-lg border border-border bg-card" />;
  }
  if (steps.length === 0) {
    return (
      <div className="h-full rounded-lg border border-border bg-card flex items-center justify-center">
        <span className="text-sm text-muted-foreground">Add filters to see the cascade.</span>
      </div>
    );
  }
  return (
    <div className="h-full rounded-lg border border-border bg-card px-2 pb-2 pt-2">
      <Table containerClassName="h-full overflow-y-auto overflow-x-clip pb-10">
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:h-8">
          <TableRow>
            <TableHead className="!pl-2">Step</TableHead>
            <TableHead className="w-20">Type</TableHead>
            <TableHead className="w-26 text-right">Count</TableHead>
            <TableHead className="w-26 text-right">Delta</TableHead>
            <TableHead className="w-44">Fraction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map((step, i) => {
            const pipelineStep = pipelineSteps[i - 1];
            const verb = pipelineStep?.verb;
            const verbMeta = verb ? VERB_META[verb] : null;
            const filterDef = pipelineStep
              ? pipelineStep.filter.kind === "all"
                ? { label: "Everyone" }
                : definitionFor(filterKey(pipelineStep.filter))
              : null;
            const label = i === 0 ? "All" : (filterDef?.label ?? "—");
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
                className={cn("cursor-pointer", isAnchor ? "bg-accent/50" : "hover:bg-accent/50")}
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
                  {delta !== null ? delta.toLocaleString() : "—"}
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
}: React.ComponentProps<typeof StepRow> & { onDragEnd?: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={props.step}
      dragListener={false}
      dragControls={controls}
      as="div"
      onDragEnd={onDragEnd}
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
}: {
  number: number;
  step: Step;
  onChange: (next: Filter) => void;
  onRemove: () => void;
  dragControls?: ReturnType<typeof useDragControls>;
}) {
  const { filter, verb } = step;
  const { color, label: verbLabel } = VERB_META[verb];
  const def =
    filter.kind === "all"
      ? { kind: "all" as const, key: "all", label: "Everyone" }
      : definitionFor((filter as Exclude<Filter, { kind: "all" }>).key);

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
            <span className="text-muted-foreground pr-2">{number}</span>
            {def?.label ?? (filter.kind === "all" ? "Everyone" : `Unknown: ${(filter as any).key}`)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${color}22`, color }}
          >
            {verbLabel}
          </span>
          <Button variant="outline" size="icon-xs" onClick={onRemove} aria-label="Remove step">
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
        <TextFilterEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
    </div>
  );
}

function TextFilterEditor({
  filter,
  def,
  onChange,
}: {
  filter: TextFilter;
  def: Extract<FilterDef, { kind: "text" }>;
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
      <span className="text-muted-foreground">{def.op === "contains" ? "Contains" : "Equals"}</span>
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
        placeholder={def.op === "contains" ? "any substring" : "exact match"}
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
  return (
    <div className="flex flex-wrap gap-1.5">
      {def.values.map((v) => {
        const selected = filter.values.includes(v.value);
        return (
          <button
            type="button"
            key={v.value}
            onClick={() => toggle(v.value)}
            className={
              selected
                ? "rounded-md border border-foreground bg-foreground/10 px-2.5 py-1 text-xs"
                : "rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:border-muted-foreground"
            }
          >
            {v.label ?? v.value}
          </button>
        );
      })}
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
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <Input
        type="number"
        min={0}
        max={120}
        value={localMin}
        onChange={(e) => setLocalMin(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-16 px-2"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <Input
        type="number"
        min={0}
        max={120}
        value={localMax}
        onChange={(e) => setLocalMax(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-16 px-2"
        placeholder="max"
      />
      <span className="text-muted-foreground">years</span>
    </div>
  );
}

function AddStepMenu({
  defs,
  isFirstStep,
  onAdd,
}: {
  defs: ReadonlyArray<FilterDef>;
  isFirstStep: boolean;
  onAdd: (verb: Verb, def: FilterDef) => void;
}) {
  const [openVerb, setOpenVerb] = useState<Verb | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const verbIcons: Record<Verb, ReactNode> = {
    narrow: <FilterIcon className="size-3" />,
    add: <Plus className="size-3" />,
    remove: <Minus className="size-3" />,
  };

  useEffect(() => {
    if (!openVerb) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenVerb(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [openVerb]);

  const allVerbs: Verb[] = ["narrow", "remove", "add"];

  return (
    <div className="flex gap-2" ref={wrapRef}>
      {allVerbs.map((verb) => {
        const { label } = VERB_META[verb];
        const disabled = isFirstStep && verb === "add"; // add only makes sense after a first step
        return (
          <div key={verb} className="relative flex-1">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => setOpenVerb((v) => (v === verb ? null : verb))}
              className="w-full gap-1.5 text-xs"
            >
              {verbIcons[verb]}
              {label}
            </Button>
            {openVerb === verb ? (
              <div
                className={cn(
                  "absolute top-full z-10 mt-1 min-w-48",
                  verb === "add" ? "right-0" : "left-0",
                  "flex flex-col rounded-md border border-border bg-background py-1 shadow-md",
                )}
              >
                {defs
                  .filter((d) => verb !== "narrow" || d.kind !== "all")
                  .map((def) => (
                    <button
                      type="button"
                      key={def.key}
                      onClick={() => {
                        onAdd(verb, def);
                        setOpenVerb(null);
                      }}
                      className="px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      {def.label}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
