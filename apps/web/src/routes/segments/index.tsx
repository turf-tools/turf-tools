import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, List, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { OTHER_PROPERTY_KEYS, type OtherPropertyDefinition } from "~/lib/voter-properties";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/segments/")({
  component: SegmentsIndex,
});

// Segment editor: dropdown to pick the active segment, filter rows on
// the left, map on the right. Mirrors the zones editor structurally so
// the management surface (Create / Rename / Save as / Delete) feels
// uniform across the two editors.
//
// Phase 1: leaf filters only, all AND'd. Phase 2 will bring composition
// (OR / NOT / segmentRef) and a density visualization on the map.

type EnumFilter = { kind: "enum"; key: string; values: string[] };
type AgeRangeFilter = { kind: "age-range"; key: string; min: number | null; max: number | null };
type Filter = EnumFilter | AgeRangeFilter;
type Query = { filters: Filter[] };

function emptyFilterFor(def: OtherPropertyDefinition): Filter {
  if (def.kind === "enum") return { kind: "enum", key: def.key, values: [] };
  return { kind: "age-range", key: def.key, min: null, max: null };
}

function definitionFor(key: string): OtherPropertyDefinition | undefined {
  return OTHER_PROPERTY_KEYS.find((d) => d.key === key);
}

function SegmentsIndex() {
  const queryClient = useQueryClient();

  const { data: segments } = useQuery({
    queryKey: ["segments"],
    queryFn: () => client.segments.list(),
    placeholderData: keepPreviousData,
  });

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [segmentDropdownOpen, setSegmentDropdownOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);

  // Default to the first segment once the list loads.
  useEffect(() => {
    if (!activeSegmentId && segments && segments.length > 0) {
      setActiveSegmentId(segments[0].segmentId);
    }
  }, [segments, activeSegmentId]);

  const activeSegment = segments?.find((s) => s.segmentId === activeSegmentId) ?? null;

  // Pull the active segment's full row (with `query`) — list responses
  // don't carry the query JSON to keep the dropdown payload small.
  const { data: activeSegmentDetail } = useQuery({
    queryKey: ["segment", activeSegmentId],
    queryFn: () => client.segments.getById({ segmentId: activeSegmentId! }),
    enabled: !!activeSegmentId,
    placeholderData: keepPreviousData,
  });

  // Local draft of the query — saved explicitly via the Save button.
  // Hydrate when a different segment's detail row arrives; never on
  // background refetches of the same segment so we don't clobber
  // in-progress edits.
  const [draft, setDraft] = useState<Query>({ filters: [] });
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!activeSegmentDetail) return;
    const q = (activeSegmentDetail.query as Query | undefined) ?? { filters: [] };
    setDraft(q);
    setDirty(false);
    // Re-hydrate only when the loaded segment id changes, not on every
    // refetch — once the user starts editing, dirty work is preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSegmentDetail?.segmentId]);

  // Autosave: every edit bumps `dirty`, a debounce fires the mutation
  // ~500ms after the user stops typing/clicking. The local draft is the
  // source of truth, so we don't invalidate after success — the cache
  // would just refetch data identical to what we already have.
  const saveQueryMutation = useMutation({
    mutationFn: () => client.segments.updateQuery({ segmentId: activeSegmentId!, query: draft }),
    onSuccess: () => setDirty(false),
    onError: (e) => console.error("segments.updateQuery failed", e),
  });

  useEffect(() => {
    if (!activeSegmentId || !dirty) return;
    const handle = setTimeout(() => saveQueryMutation.mutate(), 500);
    return () => clearTimeout(handle);
    // saveQueryMutation is stable across renders; we only re-arm when the
    // user-visible state we care about changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, activeSegmentId]);

  const renameSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; name: string }) => client.segments.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["segments"] }),
  });

  const createSegment = useDialogMutation({
    mutationFn: (input: { name: string }) => client.segments.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      setActiveSegmentId(created.segmentId);
    },
  });

  const cloneSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; newName: string }) => client.segments.clone(input),
    onSuccess: ({ segmentId }) => {
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      setActiveSegmentId(segmentId);
    },
  });

  const deleteSegment = useDialogMutation({
    mutationFn: (segmentId: string) => client.segments.remove({ segmentId }),
    onSuccess: (_res, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      const next = segments?.find((s) => s.segmentId !== deletedId);
      setActiveSegmentId(next?.segmentId ?? null);
    },
  });

  const [deleteCampaignCount, setDeleteCampaignCount] = useState(0);

  const updateFilter = (idx: number, next: Filter) => {
    setDraft((d) => ({ ...d, filters: d.filters.map((f, i) => (i === idx ? next : f)) }));
    setDirty(true);
  };
  const removeFilter = (idx: number) => {
    setDraft((d) => ({ ...d, filters: d.filters.filter((_, i) => i !== idx) }));
    setDirty(true);
  };
  const addFilter = (def: OtherPropertyDefinition) => {
    setDraft((d) => ({ ...d, filters: [...d.filters, emptyFilterFor(def)] }));
    setDirty(true);
  };

  const usedKeys = new Set(draft.filters.map((f) => f.key));
  const availableDefs = OTHER_PROPERTY_KEYS.filter((d) => !usedKeys.has(d.key));

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Segment Editor</h1>
        <div className="flex items-center gap-2">
          <DropdownMenu
            open={segmentDropdownOpen}
            onOpenChange={setSegmentDropdownOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingValueRef.current !== undefined) {
                const v = pendingValueRef.current;
                pendingValueRef.current = undefined;
                setActiveSegmentId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <List className="size-3.5" />
              <span className={activeSegment ? undefined : "invisible"}>
                {activeSegment?.name ?? "—"}
              </span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeSegmentId ?? ""}
                onValueChange={(v) => {
                  pendingValueRef.current = v;
                  setSegmentDropdownOpen(false);
                }}
              >
                {segments?.map((s) => (
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
              if (!activeSegmentId) return;
              const { count } = await queryClient.fetchQuery({
                queryKey: ["segments", "countCampaigns", activeSegmentId],
                queryFn: () => client.segments.countCampaigns({ segmentId: activeSegmentId }),
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
          {!activeSegment ? (
            <div className="text-sm text-muted-foreground italic">
              No segment selected. Create one to start defining filters.
            </div>
          ) : (
            <>
              {draft.filters.map((filter, idx) => (
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
          )}
        </div>
        <div className="col-span-2 h-full overflow-hidden rounded-lg border border-border">
          <Map className="h-full" />
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
          if (!activeSegmentId) return;
          cloneSegment.mutate({ segmentId: activeSegmentId, newName });
        }}
      />

      <RenameDialog
        open={renameSegment.isOpen}
        onOpenChange={renameSegment.onOpenChange}
        currentName={activeSegment?.name ?? ""}
        pending={renameSegment.isPending}
        error={renameSegment.error}
        onSubmit={(name) => {
          if (!activeSegmentId) return;
          if (name === activeSegment?.name) {
            renameSegment.close();
            return;
          }
          renameSegment.mutate({ segmentId: activeSegmentId, name });
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
          if (!activeSegmentId) return;
          deleteSegment.mutate(activeSegmentId);
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
              because it is used by {campaignCount} campaign{campaignCount === 1 ? "" : "s"}. Detach
              or delete those campaigns first, then try again.
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

// ---- Filter editing pieces (lifted from the old per-id editor) ----

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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="Remove filter"
          className="-translate-y-0.5"
        >
          <X className="size-5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{def.label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="Remove filter"
          className="-translate-y-0.5"
        >
          <X className="size-5" />
        </Button>
      </div>
      {filter.kind === "enum" && def.kind === "enum" ? (
        <EnumFilterEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "age-range" && def.kind === "age-range" ? (
        <AgeRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
    </div>
  );
}

function EnumFilterEditor({
  filter,
  def,
  onChange,
}: {
  filter: EnumFilter;
  def: Extract<OtherPropertyDefinition, { kind: "enum" }>;
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
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <input
        type="number"
        min={0}
        max={120}
        value={filter.min ?? ""}
        onChange={(e) =>
          onChange({ ...filter, min: e.target.value === "" ? null : Number(e.target.value) })
        }
        className="w-16 rounded-md border border-border bg-background px-2 py-1"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <input
        type="number"
        min={0}
        max={120}
        value={filter.max ?? ""}
        onChange={(e) =>
          onChange({ ...filter, max: e.target.value === "" ? null : Number(e.target.value) })
        }
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
  defs: ReadonlyArray<OtherPropertyDefinition>;
  onPick: (def: OtherPropertyDefinition) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
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
            "absolute top-full left-0 right-0 z-10 mt-1",
            "flex flex-col rounded-md border border-border bg-background py-1 shadow-md",
          )}
          onMouseLeave={() => setOpen(false)}
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
