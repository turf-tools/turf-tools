import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import { Input } from "~/components/input";
import { Map } from "~/components/map";
import {
  type AgeRangeFilter,
  type Criteria,
  definitionFor,
  emptyFilterFor,
  type EnumFilter,
  type Filter,
  type FilterDef,
  FILTERS,
  isActiveFilter,
  type TextFilter,
} from "~/lib/filters";
import { segmentDetailQuery, segmentPreviewQuery, segmentsListQuery } from "~/lib/queries/segments";
import { cn } from "~/lib/utils";
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

  // Read filters straight from the detail cache — no separate draft layer.
  // The optimistic mutation below writes to the same cache, so commits
  // reflect on the next render without a hydration step.
  const filters = (activeSegmentDetail?.criteria as Criteria | undefined)?.filters ?? [];

  // Preview keys on active filters only so adding/removing an empty filter
  // doesn't trigger a refetch.
  const effectiveCriteria = useMemo<Criteria>(
    () => ({ filters: filters.filter(isActiveFilter) }),
    [filters],
  );
  const { data: preview, isPlaceholderData: stale } = useQuery({
    ...segmentPreviewQuery(effectiveCriteria),
    enabled: !!activeSegmentDetail,
    placeholderData: keepPreviousData,
  });
  const counts = preview?.counts;
  const pointsBuffer = preview?.pointsBuffer;

  // Optimistic update: write into the ["segment", id] cache in onMutate,
  // snapshot for rollback, restore on error. The cache is the single
  // source of truth — `filters` above reads from it.
  const updateCriteriaMutation = useMutation({
    mutationFn: (input: { segmentId: string; criteria: Criteria }) =>
      client.segments.updateCriteria({ segmentId: input.segmentId, criteria: input.criteria }),
    onMutate: async ({ segmentId: id, criteria }) => {
      await queryClient.cancelQueries({ queryKey: ["segment", id] });
      const previous = queryClient.getQueryData(["segment", id]);
      queryClient.setQueryData(["segment", id], (old: { criteria: unknown } | null | undefined) =>
        old ? { ...old, criteria } : old,
      );
      return { previous };
    },
    onError: (e, { segmentId: id }, ctx) => {
      console.error("segments.updateCriteria failed", e);
      if (ctx?.previous) queryClient.setQueryData(["segment", id], ctx.previous);
    },
  });

  const commit = (nextFilters: Filter[]) => {
    updateCriteriaMutation.mutate({ segmentId, criteria: { filters: nextFilters } });
  };
  const updateFilter = (idx: number, next: Filter) =>
    commit(filters.map((f, i) => (i === idx ? next : f)));
  const removeFilter = (idx: number) => commit(filters.filter((_, i) => i !== idx));
  const addFilter = (def: FilterDef) => commit([...filters, emptyFilterFor(def)]);

  const usedKeys = new Set(filters.map((f) => f.key));
  const availableDefs = FILTERS.filter((d) => !usedKeys.has(d.key));

  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      <div className="col-span-1 flex flex-col gap-3 overflow-y-auto">
        {activeSegmentDetail ? (
          <>
            {filters.map((filter, idx) => (
              <FilterRow
                key={`${filter.key}-${idx}`}
                filter={filter}
                onChange={(next) => updateFilter(idx, next)}
                onRemove={() => removeFilter(idx)}
              />
            ))}
            {availableDefs.length > 0 ? (
              <AddFilterMenu defs={availableDefs} onPick={addFilter} />
            ) : null}
          </>
        ) : null}
      </div>
      <div className="col-span-2 flex h-full flex-col gap-3">
        <div className={cn("flex-1 transition-opacity", stale ? "opacity-70" : null)}>
          {/* Map curtain stays up until the first preview lands; after
              that `preview` stays defined via keepPreviousData, so
              filter-change transitions use the dim wrapper instead. */}
          <Map className="h-full" points={pointsBuffer} loading={!preview} />
        </div>
        <CountsPanel counts={counts} stale={stale} />
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
          "grid grid-cols-3 gap-4",
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

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: Filter;
  onChange: (next: Filter) => void;
  onRemove: () => void;
}) {
  const def = definitionFor(filter.key);
  if (!def) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
        <span>Unknown property: {filter.key}</span>
        <Button variant="outline" size="icon-sm" onClick={onRemove} aria-label="Remove filter">
          <X className="size-4" />
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm">{def.label}</span>
        <Button variant="outline" size="icon-sm" onClick={onRemove} aria-label="Remove filter">
          <X className="size-4" />
        </Button>
      </div>
      {filter.kind === "enum" && def.kind === "enum" ? (
        <EnumFilterEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "age-range" && def.kind === "age-range" ? (
        <AgeRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "text" && def.kind === "text" ? (
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

function AddFilterMenu({
  defs,
  onPick,
}: {
  defs: ReadonlyArray<FilterDef>;
  onPick: (def: FilterDef) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Close on click outside the menu wrapper.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);
  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-11 w-full items-center gap-2",
          "rounded-md border border-border bg-card px-3 py-2 text-left text-sm",
          "text-muted-foreground hover:border-muted-foreground hover:text-foreground",
        )}
      >
        <Plus className="size-3.5" />
        <span>Add filter</span>
      </button>
      {open ? (
        <div
          className={cn(
            "absolute top-full right-0 left-0 z-10 mt-1",
            "flex flex-col rounded-md border border-border bg-background py-1 shadow-md",
          )}
        >
          {defs.map((def) => (
            <button
              type="button"
              key={def.key}
              onClick={() => {
                onPick(def);
                setOpen(false);
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
}
