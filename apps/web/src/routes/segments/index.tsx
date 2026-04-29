import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Copy, List, Pencil, Plus, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
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
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

type SegmentsSearch = {
  segmentId?: string;
};

// Sort segments alphabetically by name. Used by the dropdown and the
// loader's "redirect to a segment" fallback so both pick consistently.
function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/segments/")({
  validateSearch: (s): SegmentsSearch => ({
    segmentId: typeof s.segmentId === "string" ? s.segmentId : undefined,
  }),
  loaderDeps: ({ search }) => ({ segmentId: search.segmentId }),
  loader: async ({ context: { queryClient }, deps }) => {
    const segments = await queryClient.fetchQuery(segmentsListQuery());
    const sorted = sortByName(segments);
    const fallbackId = sorted[0]?.segmentId;

    const idInUrl = deps.segmentId;
    const exists = idInUrl ? segments.some((s) => s.segmentId === idInUrl) : false;

    if (!idInUrl || !exists) {
      if (fallbackId) {
        throw redirect({ to: "/segments", search: { segmentId: fallbackId } });
      }
      // No segments at all — render with no active segment.
      return;
    }

    await queryClient.fetchQuery(segmentDetailQuery(idInUrl));
  },
  component: SegmentsIndex,
});

// Segment editor: dropdown to pick the active segment, filter rows on
// the left, map on the right.
function SegmentsIndex() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const { segmentId = null } = Route.useSearch();
  const shouldFade = useFadeOnce("/segments");

  const setActiveSegmentId = (id: string | null) => {
    void navigate({ search: { segmentId: id ?? undefined } });
  };

  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const sortedSegments = useMemo(() => sortByName(segments), [segments]);

  const segmentDropdown = useDeferredRadioDropdown({
    onCommit: (id) => setActiveSegmentId(id || null),
  });

  const activeSegment = segments.find((s) => s.segmentId === segmentId) ?? null;

  // Loader prefetched when `segmentId` is set, so this is a cache hit.
  // `enabled: false` when no segment is active (empty state).
  const { data: activeSegmentDetail } = useQuery({
    ...segmentDetailQuery(segmentId ?? ""),
    enabled: !!segmentId,
  });

  // Read filters straight from the detail cache — no separate draft layer.
  // The optimistic mutation below writes to the same cache, so commits
  // reflect on the next render without a hydration step.
  const filters = (activeSegmentDetail?.criteria as Criteria | undefined)?.filters ?? [];

  // Preview keys on active filters only so adding/removing an empty filter
  // doesn't trigger a refetch. One query fetches counts and points in
  // parallel — `data` only updates when both resolve, so map and counts
  // can never disagree.
  const effectiveCriteria = useMemo<Criteria>(
    () => ({ filters: filters.filter(isActiveFilter) }),
    [filters],
  );
  // `placeholderData: keepPreviousData` + `isPlaceholderData` is what
  // gives us "show stale data dimmed while the new key fetches" — the
  // canonical signal for filter-commit transitions. Stays in-component
  // (not in the loader) so this UX is preserved.
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
    onMutate: async ({ segmentId, criteria }) => {
      await queryClient.cancelQueries({ queryKey: ["segment", segmentId] });
      const previous = queryClient.getQueryData(["segment", segmentId]);
      queryClient.setQueryData(
        ["segment", segmentId],
        (old: { criteria: unknown } | null | undefined) => (old ? { ...old, criteria } : old),
      );
      return { previous };
    },
    onError: (e, { segmentId }, ctx) => {
      console.error("segments.updateCriteria failed", e);
      if (ctx?.previous) queryClient.setQueryData(["segment", segmentId], ctx.previous);
    },
  });

  const renameSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; name: string }) => client.segments.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["segments"] }),
  });

  const createSegment = useDialogMutation({
    mutationFn: (input: { name: string }) => client.segments.create(input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
      setActiveSegmentId(created.segmentId);
    },
  });

  const cloneSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; newName: string }) => client.segments.clone(input),
    onSuccess: ({ segmentId: cloneId }) => {
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
      setActiveSegmentId(cloneId);
    },
  });

  const deleteSegment = useDialogMutation({
    mutationFn: (segmentId: string) => client.segments.remove({ segmentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
      // Clear the URL id; the loader picks the alphabetical-first survivor.
      setActiveSegmentId(null);
    },
  });

  const [deleteCampaignCount, setDeleteCampaignCount] = useState(0);

  const commit = (nextFilters: Filter[]) => {
    if (!segmentId) return;
    updateCriteriaMutation.mutate({ segmentId, criteria: { filters: nextFilters } });
  };
  const updateFilter = (idx: number, next: Filter) =>
    commit(filters.map((f, i) => (i === idx ? next : f)));
  const removeFilter = (idx: number) => commit(filters.filter((_, i) => i !== idx));
  const addFilter = (def: FilterDef) => commit([...filters, emptyFilterFor(def)]);

  const usedKeys = new Set(filters.map((f) => f.key));
  const availableDefs = FILTERS.filter((d) => !usedKeys.has(d.key));

  return (
    <>
      <div className={shouldFade ? "animate-in fade-in duration-100" : undefined}>
        <div className="mb-4 flex h-8 items-center justify-between">
          <h1 className="text-xl font-extrabold tracking-wide italic">Segment Editor</h1>
          <div className="flex items-center gap-2">
            <DropdownMenu {...segmentDropdown.menu}>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                <List className="size-3.5" />
                <span className={activeSegment ? undefined : "invisible"}>
                  {activeSegment?.name ?? "—"}
                </span>
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuRadioGroup {...segmentDropdown.radio} value={segmentId ?? ""}>
                  {sortedSegments.map((s) => (
                    <DropdownMenuRadioItem key={s.segmentId} value={s.segmentId}>
                      {s.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={createSegment.open}>
              <Plus />
              New segment
            </Button>
            <Button variant="outline" onClick={renameSegment.open} disabled={!activeSegment}>
              <Pencil />
              Rename
            </Button>
            <Button variant="outline" onClick={cloneSegment.open} disabled={!activeSegment}>
              <Copy />
              Duplicate
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!segmentId) return;
                const { count } = await queryClient.fetchQuery({
                  queryKey: ["segments", "count-campaigns", segmentId],
                  queryFn: () => client.segments.countCampaigns({ segmentId }),
                  staleTime: 0,
                });
                setDeleteCampaignCount(count);
                deleteSegment.open();
              }}
              disabled={!activeSegment}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 h-[calc(100vh-9.75rem)]">
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
            <CountsPanel counts={counts} stale={stale} disabled={!segmentId} />
          </div>
        </div>
      </div>

      <CreateSegmentDialog
        open={createSegment.isOpen}
        onOpenChange={createSegment.onOpenChange}
        pending={createSegment.isPending}
        error={createSegment.error}
        onSubmit={(name) => createSegment.mutate({ name })}
      />

      <SaveAsDialog
        open={cloneSegment.isOpen}
        onOpenChange={cloneSegment.onOpenChange}
        defaultName={activeSegment ? `${activeSegment.name} (copy)` : ""}
        pending={cloneSegment.isPending}
        error={cloneSegment.error}
        onSubmit={(newName) => {
          if (!segmentId) return;
          cloneSegment.mutate({ segmentId, newName });
        }}
      />

      <RenameDialog
        open={renameSegment.isOpen}
        onOpenChange={renameSegment.onOpenChange}
        currentName={activeSegment?.name ?? ""}
        pending={renameSegment.isPending}
        error={renameSegment.error}
        onSubmit={(name) => {
          if (!segmentId) return;
          if (name === activeSegment?.name) {
            renameSegment.close();
            return;
          }
          renameSegment.mutate({ segmentId, name });
        }}
      />

      <DeleteDialog
        open={deleteSegment.isOpen}
        onOpenChange={deleteSegment.onOpenChange}
        segmentName={activeSegment?.name ?? ""}
        campaignCount={deleteCampaignCount}
        pending={deleteSegment.isPending}
        error={deleteSegment.error}
        onConfirm={() => {
          if (!segmentId) return;
          deleteSegment.mutate(segmentId);
        }}
      />
    </>
  );
}

function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10",
        "px-3 py-2 text-sm text-destructive",
      )}
    >
      {error}
    </div>
  );
}

function CreateSegmentDialog({
  open,
  onOpenChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new segment</DialogTitle>
        <DialogDescription>
          A segment is a named query over people. Start with a name and add filters in the editor.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SaveAsDialog({
  open,
  onOpenChange,
  defaultName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (newName: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Duplicate segment</DialogTitle>
        <DialogDescription>
          Creates a copy of the current segment, including its query.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Duplicate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  currentName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename segment</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5 mt-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  segmentName,
  campaignCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segmentName: string;
  campaignCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = campaignCount > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete segment?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{segmentName}</span>{" "}
              because it is used by{" "}
              <span className="font-bold text-foreground">{campaignCount}</span> campaign
              {campaignCount === 1 ? "" : "s"}. Detach or delete those campaigns first, then try
              again.
            </>
          ) : (
            <>
              Permanently deletes <span className="font-medium text-foreground">{segmentName}</span>
              . This can't be undone.
            </>
          )}
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          {inUse ? (
            <DialogClose render={<Button variant="outline" />}>OK</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                Delete segment
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CountsPanel({
  counts,
  stale,
  disabled,
}: {
  counts:
    | {
        personCount: number;
        doorCount: number;
        buildingCount: number;
        samplePeople: Array<Record<string, unknown>>;
      }
    | undefined;
  stale: boolean;
  disabled: boolean;
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
        <Stat label="Persons" value={disabled ? null : counts?.personCount} />
        <Stat label="Doors" value={disabled ? null : counts?.doorCount} />
        <Stat label="Buildings" value={disabled ? null : counts?.buildingCount} />
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
      <input
        type="number"
        min={0}
        max={120}
        value={localMin}
        onChange={(e) => setLocalMin(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="w-16 rounded-md border border-border bg-background px-2 py-1"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <input
        type="number"
        min={0}
        max={120}
        value={localMax}
        onChange={(e) => setLocalMax(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="w-16 rounded-md border border-border bg-background px-2 py-1"
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
          "flex w-full items-center gap-2",
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
