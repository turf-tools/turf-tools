import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
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

  const steps = (activeSegmentDetail?.criteria as Pipeline | null)?.steps ?? [];

  // Only steps with active filters drive queries — adding an empty step
  // doesn't trigger a refetch.
  const effectivePipeline = useMemo<Pipeline>(
    () => ({ steps: steps.filter(isActiveStep) }),
    [steps],
  );

  const [view, setView] = useState<"map" | "list" | "waterfall">("map");

  const { data: counts, isPlaceholderData: countsStale } = useQuery({
    ...segmentCountsQuery(effectivePipeline),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const { data: pointsBuffer, isPlaceholderData: pointsStale } = useQuery({
    ...segmentPointsQuery(effectivePipeline),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const {
    data: sample,
    isPlaceholderData: sampleStale,
    isLoading: sampleLoading,
  } = useQuery({
    ...segmentSampleQuery(effectivePipeline),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const { data: cascade, isPlaceholderData: cascadeStale } = useQuery({
    ...segmentCascadeQuery(effectivePipeline),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });

  // stale = counts loading OR the active view's own data loading.
  const activeViewStale =
    view === "map"
      ? pointsStale
      : view === "list"
        ? sampleStale
        : view === "waterfall"
          ? cascadeStale
          : false;
  const stale = countsStale || activeViewStale;

  // Stable refs — written during render so each update is synchronous with
  // the stale→false transition, no intermediate render with new data while faded.
  const stableCountsRef = useRef<typeof counts>(undefined);
  if (!stale) stableCountsRef.current = counts;

  const stablePointsRef = useRef<typeof pointsBuffer>(undefined);
  if (!stale) stablePointsRef.current = pointsBuffer;

  const stablePersonsRef = useRef<NonNullable<typeof sample>["persons"]>([]);
  if (!stale) stablePersonsRef.current = sample?.persons ?? stablePersonsRef.current;

  const stableCascadeRef = useRef<typeof cascade>(undefined);
  if (!stale) stableCascadeRef.current = cascade;

  // Must update in lockstep with stableCascadeRef so verb labels match
  // the step counts they annotate.
  const stablePipelineStepsRef = useRef<Step[]>([]);
  if (!stale) stablePipelineStepsRef.current = effectivePipeline.steps;

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
  const removeStep = (idx: number) => commit(steps.filter((_, i) => i !== idx));
  const addStep = (verb: Verb, def: FilterDef) =>
    commit([...steps, { verb, filter: emptyFilterFor(def) }]);

  const usedKeys = new Set(steps.map((s) => filterKey(s.filter)));
  const availableDefs = FILTERS.filter((d) => !usedKeys.has(d.key));

  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      <div className="col-span-1 flex flex-col gap-3 overflow-y-auto">
        {activeSegmentDetail ? (
          <>
            {steps.map((step, idx) => (
              <StepRow
                key={`${filterKey(step.filter)}-${idx}`}
                step={step}
                onChange={(next) => updateStep(idx, { ...step, filter: next })}
                onRemove={() => removeStep(idx)}
              />
            ))}
            {availableDefs.length > 0 ? (
              <AddStepMenu defs={availableDefs} isFirstStep={steps.length === 0} onAdd={addStep} />
            ) : null}
          </>
        ) : null}
      </div>
      <div className="col-span-2 flex h-full min-h-0 flex-col gap-3">
        <div className="relative flex-1 min-h-0">
          <div className={cn("h-full min-h-0 transition-opacity", stale ? "opacity-50" : null)}>
            {view === "map" ? (
              <Map
                className="h-full"
                points={stablePointsRef.current}
                loading={!stablePointsRef.current}
              />
            ) : view === "list" ? (
              <SamplePanel persons={stablePersonsRef.current} isLoading={sampleLoading} />
            ) : (
              <WaterfallPanel
                steps={stableCascadeRef.current?.steps ?? []}
                pipelineSteps={stablePipelineStepsRef.current}
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
              <ToggleGroupItem value="list">List</ToggleGroupItem>
              <ToggleGroupItem value="waterfall">Waterfall</ToggleGroupItem>
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
  isLoading,
}: {
  persons: NonNullable<Awaited<ReturnType<typeof client.segments.sample>>>["persons"];
  isLoading: boolean;
}) {
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
          {isLoading && persons.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                Loading sample…
              </TableCell>
            </TableRow>
          ) : persons.length === 0 ? (
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

function WaterfallPanel({ steps, pipelineSteps }: { steps: CascadeStep[]; pipelineSteps: Step[] }) {
  const [anchor, setAnchor] = useState(0);
  const effectiveAnchor = Math.min(anchor, steps.length - 1);
  const anchorCount = steps[effectiveAnchor]?.count ?? 0;

  if (steps.length === 0) {
    return (
      <div className="h-full rounded-lg border border-border bg-card flex items-center justify-center">
        <span className="text-sm text-muted-foreground">Add filters to see the cascade.</span>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-col gap-1">
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
          const delta = isAnchor || above ? null : step.count - anchorCount;
          const pct =
            !above && anchorCount > 0 ? Math.round((step.count / anchorCount) * 100) : null;
          return (
            <div
              key={i}
              onClick={() => setAnchor(i)}
              className={cn(
                "flex items-baseline gap-3 py-1 -mx-2 px-2 rounded cursor-pointer",
                isAnchor ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">{label}</span>
              {verbMeta ? (
                <span
                  className="w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-medium"
                  style={{ backgroundColor: `${verbMeta.color}22`, color: verbMeta.color }}
                >
                  {verbMeta.label}
                </span>
              ) : (
                <span className="w-14 shrink-0" />
              )}
              <span className="w-24 shrink-0 text-right tabular-nums text-sm font-medium">
                {step.count.toLocaleString()}
              </span>
              <span
                className={cn(
                  "w-20 shrink-0 text-right tabular-nums text-sm",
                  delta !== null && delta < 0 ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {delta !== null ? delta.toLocaleString() : "—"}
              </span>
              <span className="text-sm text-muted-foreground">
                {pct !== null ? `${pct}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>
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

function StepRow({
  step,
  onChange,
  onRemove,
}: {
  step: Step;
  onChange: (next: Filter) => void;
  onRemove: () => void;
}) {
  const { filter, verb } = step;
  const { color, label: verbLabel } = VERB_META[verb];
  const def =
    filter.kind === "all"
      ? { kind: "all" as const, key: "all", label: "Everyone" }
      : definitionFor((filter as Exclude<Filter, { kind: "all" }>).key);

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${color}22`, color }}
          >
            {verbLabel}
          </span>
          <span className="text-sm">
            {def?.label ?? (filter.kind === "all" ? "Everyone" : `Unknown: ${(filter as any).key}`)}
          </span>
        </div>
        <Button variant="outline" size="icon-sm" onClick={onRemove} aria-label="Remove step">
          <X className="size-4" />
        </Button>
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
  const verbs: Verb[] = isFirstStep ? ["narrow", "remove"] : ["narrow", "add", "remove"];

  useEffect(() => {
    if (!openVerb) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenVerb(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [openVerb]);

  return (
    <div className="flex gap-2" ref={wrapRef}>
      {verbs.map((verb) => {
        const { color, label } = VERB_META[verb];
        return (
          <div key={verb} className="relative flex-1">
            <button
              type="button"
              onClick={() => setOpenVerb((v) => (v === verb ? null : verb))}
              className={cn(
                "flex h-9 w-full items-center justify-center gap-1.5 rounded-md border text-xs",
                openVerb === verb
                  ? "border-transparent"
                  : "border-border hover:border-muted-foreground",
              )}
              style={openVerb === verb ? { backgroundColor: `${color}22`, color } : {}}
            >
              <Plus className="size-3" />
              {label}
            </button>
            {openVerb === verb ? (
              <div
                className={cn(
                  "absolute top-full left-0 right-0 z-10 mt-1",
                  "flex flex-col rounded-md border border-border bg-background py-1 shadow-md",
                )}
              >
                {defs.map((def) => (
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
