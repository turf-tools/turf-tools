import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrushCleaning, ChevronDown, Copy, List, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Pill } from "~/components/pill";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/zones/")({
  component: ZonesIndex,
});

// Distinct fill colors for zones in a group. Tailwind's 500 scale across
// the rainbow, shuffled so adjacent zones land on far-apart hues — up to
// 17 zones render distinctly; beyond that the cycle repeats.
const ZONE_COLORS = [
  "#3b82f6", // blue-500
  "#f97316", // orange-500
  "#22c55e", // green-500
  "#d946ef", // fuchsia-500
  "#eab308", // yellow-500
  "#06b6d4", // cyan-500
  "#ec4899", // pink-500
  "#84cc16", // lime-500
  "#8b5cf6", // violet-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#0ea5e9", // sky-500
  "#f59e0b", // amber-500
  "#a855f7", // purple-500
  "#14b8a6", // teal-500
  "#ef4444", // red-500
  "#6366f1", // indigo-500
];
function colorFor(i: number): string {
  return ZONE_COLORS[i % ZONE_COLORS.length]!;
}

// Hardcoded for now — eventually will come from a data-service registry
// endpoint that enumerates which `boundaries.*` tables exist for an org.
const KEY_GROUPS_AVAILABLE = [
  { value: "nyc_eds", label: "NYC EDs" },
  { value: "nyc_zips", label: "NYC ZIPs" },
];

function ZonesIndex() {
  const queryClient = useQueryClient();

  const { data: zoneGroups } = useQuery({
    queryKey: ["zoneGroups"],
    queryFn: () => client.zoneGroups.list(),
    placeholderData: keepPreviousData,
  });

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!activeGroupId && zoneGroups && zoneGroups.length > 0) {
      setActiveGroupId(zoneGroups[0].zoneGroupId);
    }
  }, [zoneGroups, activeGroupId]);

  const activeGroup = zoneGroups?.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const { data: zones } = useQuery({
    queryKey: ["zones", activeGroupId],
    queryFn: () => client.zones.list({ zoneGroupId: activeGroupId! }),
    enabled: !!activeGroupId,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setActiveZoneId(null);
  }, [activeGroupId]);

  const updateKeysMutation = useMutation({
    mutationFn: (input: { zoneId: string; keys: string[] }) => client.zones.updateKeys(input),
    onMutate: async ({ zoneId, keys }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", activeGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", activeGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", activeGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, keys } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.updateKeys failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", activeGroupId], ctx.previous);
    },
    // No onSettled invalidate: optimistic write is a complete mirror of
    // what the server stores, so a refetch would just re-fetch identical
    // data and flash the global indicator on every polygon click.
  });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zoneGroups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      setActiveGroupId(created.zoneGroupId);
    },
  });

  const cloneGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; newName: string }) => client.zoneGroups.clone(input),
    onSuccess: ({ zoneGroupId }) => {
      queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      setActiveGroupId(zoneGroupId);
    },
  });

  const clearZones = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zones.removeAllInGroup({ zoneGroupId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] }),
  });

  const deleteGroup = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zoneGroups.remove({ zoneGroupId }),
    onSuccess: (_res, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["zoneGroups"] });
      // Pick another group (first surviving) so the editor doesn't
      // freeze on a dangling id.
      const next = zoneGroups?.find((g) => g.zoneGroupId !== deletedId);
      setActiveGroupId(next?.zoneGroupId ?? null);
      setActiveZoneId(null);
    },
  });

  const createZoneMutation = useMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zones.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] });
      setActiveZoneId(created.zoneId);
    },
    onError: (e) => console.error("zones.create failed", e),
  });

  const renameZoneMutation = useMutation({
    mutationFn: (input: { zoneId: string; name: string }) => client.zones.rename(input),
    onMutate: async ({ zoneId, name }) => {
      await queryClient.cancelQueries({ queryKey: ["zones", activeGroupId] });
      const previous = queryClient.getQueryData<typeof zones>(["zones", activeGroupId]);
      queryClient.setQueryData<typeof zones>(["zones", activeGroupId], (old) =>
        old?.map((z) => (z.zoneId === zoneId ? { ...z, name } : z)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zones.rename failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zones", activeGroupId], ctx.previous);
    },
    // No onSettled invalidate: same reasoning as updateKeysMutation.
  });

  const removeZoneMutation = useMutation({
    mutationFn: (zoneId: string) => client.zones.remove({ zoneId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zones", activeGroupId] }),
    onError: (e) => console.error("zones.remove failed", e),
  });

  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const commitRename = (zoneId: string, currentName: string) => {
    const next = renameDraft.trim();
    setRenamingZoneId(null);
    if (next.length === 0 || next === currentName) return;
    renameZoneMutation.mutate({ zoneId, name: next });
  };

  const coloringByKey = useMemo(() => {
    const out: Record<string, string> = {};
    zones?.forEach((zone, idx) => {
      const color = colorFor(idx);
      for (const key of zone.keys) out[key] = color;
    });
    return out;
  }, [zones]);

  const handlePolygonClick = (key: string) => {
    if (!activeZoneId || !zones) return;
    const active = zones.find((z) => z.zoneId === activeZoneId);
    if (!active) return;

    if (active.keys.includes(key)) {
      updateKeysMutation.mutate({
        zoneId: activeZoneId,
        keys: active.keys.filter((k) => k !== key),
      });
      return;
    }

    // A key belongs to at most one zone in the group. If another zone
    // already owns it, strip it from there before adding to the active
    // zone — both mutations fire optimistically.
    const previousOwner = zones.find((z) => z.zoneId !== activeZoneId && z.keys.includes(key));
    if (previousOwner) {
      updateKeysMutation.mutate({
        zoneId: previousOwner.zoneId,
        keys: previousOwner.keys.filter((k) => k !== key),
      });
    }
    updateKeysMutation.mutate({
      zoneId: activeZoneId,
      keys: [...active.keys, key],
    });
  };

  // ---- Modal state ----
  // The five dialog mutations (createGroup, renameGroup, cloneGroup,
  // clearZones, deleteGroup) own their own open flags via
  // `useDialogMutation`; this local state is only for the data Delete
  // needs to pre-fetch before opening (campaign-usage count).
  const [deleteCampaignCount, setDeleteCampaignCount] = useState(0);

  // Click anywhere outside the map deselects the active zone. Clicks on
  // zone buttons in the list still bubble to this handler (clearing the
  // selection), but the button's own onClick fires right after and
  // re-sets the selection — net result is the right zone ends up active.
  // Skipped while any modal/inline-rename is open so we don't clobber
  // state behind a dialog.
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeZoneId) return;
    if (
      createGroup.isOpen ||
      cloneGroup.isOpen ||
      clearZones.isOpen ||
      renameGroup.isOpen ||
      deleteGroup.isOpen ||
      renamingZoneId
    ) {
      return;
    }
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mapWrapperRef.current?.contains(target)) return;
      setActiveZoneId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [
    activeZoneId,
    createGroup.isOpen,
    cloneGroup.isOpen,
    clearZones.isOpen,
    renameGroup.isOpen,
    deleteGroup.isOpen,
    renamingZoneId,
  ]);

  return (
    <>
      <div className="mb-4 flex h-8 items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-wide italic">Zone Editor</h1>
        <div className="flex items-center gap-2">
          <DropdownMenu
            open={groupOpen}
            onOpenChange={setGroupOpen}
            onOpenChangeComplete={(isOpen) => {
              if (!isOpen && pendingValueRef.current !== undefined) {
                const v = pendingValueRef.current;
                pendingValueRef.current = undefined;
                setActiveGroupId(v);
              }
            }}
          >
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <List className="size-3.5" />
              <span className={activeGroup ? undefined : "invisible"}>
                {activeGroup?.name ?? "—"}
              </span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={activeGroupId ?? ""}
                onValueChange={(v) => {
                  pendingValueRef.current = v;
                  setGroupOpen(false);
                }}
              >
                {zoneGroups?.map((g) => (
                  <DropdownMenuRadioItem key={g.zoneGroupId} value={g.zoneGroupId}>
                    {g.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={createGroup.open}>
            <Plus />
            New group
          </Button>
          <Button variant="outline" onClick={renameGroup.open}>
            <Pencil />
            Rename
          </Button>
          <Button variant="outline" onClick={cloneGroup.open}>
            <Copy />
            Duplicate
          </Button>
          <Button variant="outline" onClick={clearZones.open}>
            <BrushCleaning />
            Clear
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (!activeGroupId) return;
              // Fetch first, open after — avoids a "Checking…" flash in
              // the dialog and keeps the count fresh per click.
              const { count } = await queryClient.fetchQuery({
                queryKey: ["zoneGroups", "countCampaigns", activeGroupId],
                queryFn: () => client.zoneGroups.countCampaigns({ zoneGroupId: activeGroupId }),
                staleTime: 0,
              });
              setDeleteCampaignCount(count);
              deleteGroup.open();
            }}
            disabled={!activeGroup}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 h-[calc(100vh-9.75rem)]">
        <div className="col-span-1 flex flex-col gap-2 overflow-y-auto">
          {zones?.map((zone, idx) => {
            const isActive = zone.zoneId === activeZoneId;
            const isRenaming = renamingZoneId === zone.zoneId;
            return (
              <div
                key={zone.zoneId}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (isRenaming) return;
                  setActiveZoneId(isActive ? null : zone.zoneId);
                }}
                onKeyDown={(e) => {
                  if (isRenaming) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveZoneId(isActive ? null : zone.zoneId);
                  }
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-card py-2 pr-2 pl-3 text-left",
                  isActive ? "border-foreground" : "border-border hover:border-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className="mr-1 size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: colorFor(idx) }}
                />
                {isRenaming ? (
                  <Input
                    autoFocus
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(zone.zoneId, zone.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(zone.zoneId, zone.name);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingZoneId(null);
                      }
                    }}
                    className="h-7 flex-1 px-2 text-sm"
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm">{zone.name}</span>
                    <button
                      type="button"
                      aria-label="Rename zone"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameDraft(zone.name);
                        setRenamingZoneId(zone.zoneId);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label="Delete zone"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeZoneId === zone.zoneId) setActiveZoneId(null);
                    removeZoneMutation.mutate(zone.zoneId);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                </button>
                <span className="w-9 shrink-0">
                  <Pill variant="number" className="justify-center">
                    {zone.keys.length}
                  </Pill>
                </span>
              </div>
            );
          })}
          {activeGroupId ? (
            <button
              type="button"
              onClick={() =>
                createZoneMutation.mutate({
                  zoneGroupId: activeGroupId,
                  name: `Zone ${(zones?.length ?? 0) + 1}`,
                })
              }
              className={cn(
                "flex items-center justify-between gap-2",
                "rounded-md border border-border bg-card px-3 py-2 text-left",
                "text-muted-foreground hover:border-muted-foreground hover:text-foreground",
              )}
            >
              <div className="flex items-center gap-2">
                <Plus className="size-3.5" />
                <span className="text-sm">New zone</span>
              </div>
            </button>
          ) : null}
        </div>
        <div
          ref={mapWrapperRef}
          className="col-span-2 h-full overflow-hidden rounded-lg border border-border"
        >
          <Map
            className="h-full"
            boundariesUrl={
              activeGroup
                ? `${import.meta.env.VITE_DATA_URL ?? "http://localhost:8000"}/key-groups/${activeGroup.keyGroup}/geojson?v=${new Date(activeGroup.updatedAt).getTime()}`
                : undefined
            }
            coloringByKey={coloringByKey}
            onPolygonClick={activeZoneId ? handlePolygonClick : undefined}
          />
        </div>
      </div>

      <CreateZoneGroupDialog
        open={createGroup.isOpen}
        onOpenChange={createGroup.onOpenChange}
        pending={createGroup.isPending}
        error={createGroup.error}
        onSubmit={(values) => createGroup.mutate(values)}
      />

      <SaveAsDialog
        open={cloneGroup.isOpen}
        onOpenChange={cloneGroup.onOpenChange}
        defaultName={activeGroup ? `${activeGroup.name} (copy)` : ""}
        pending={cloneGroup.isPending}
        error={cloneGroup.error}
        onSubmit={(newName) => {
          if (!activeGroupId) return;
          cloneGroup.mutate({ zoneGroupId: activeGroupId, newName });
        }}
      />

      <ClearDialog
        open={clearZones.isOpen}
        onOpenChange={clearZones.onOpenChange}
        groupName={activeGroup?.name ?? ""}
        pending={clearZones.isPending}
        error={clearZones.error}
        onConfirm={() => {
          if (!activeGroupId) return;
          clearZones.mutate(activeGroupId);
        }}
      />

      <RenameDialog
        open={renameGroup.isOpen}
        onOpenChange={renameGroup.onOpenChange}
        currentName={activeGroup?.name ?? ""}
        pending={renameGroup.isPending}
        error={renameGroup.error}
        onSubmit={(name) => {
          if (!activeGroupId) return;
          if (name === activeGroup?.name) {
            renameGroup.close();
            return;
          }
          renameGroup.mutate({ zoneGroupId: activeGroupId, name });
        }}
      />

      <DeleteDialog
        open={deleteGroup.isOpen}
        onOpenChange={deleteGroup.onOpenChange}
        groupName={activeGroup?.name ?? ""}
        campaignCount={deleteCampaignCount}
        pending={deleteGroup.isPending}
        error={deleteGroup.error}
        onConfirm={() => {
          if (!activeGroupId) return;
          deleteGroup.mutate(activeGroupId);
        }}
      />
    </>
  );
}

// Inline error block for dialog action mutations. Renders nothing when
// there's no error, so callers can drop it in unconditionally.
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
        <DialogTitle>Rename group</DialogTitle>
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

function CreateZoneGroupDialog({
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
  onSubmit: (values: { name: string; keyGroup: string }) => void;
}) {
  const [name, setName] = useState("");
  const [keyGroup, setKeyGroup] = useState(KEY_GROUPS_AVAILABLE[0]!.value);

  useEffect(() => {
    if (open) {
      setName("");
      setKeyGroup(KEY_GROUPS_AVAILABLE[0]!.value);
    }
  }, [open]);

  const valid = name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new group</DialogTitle>
        <DialogDescription>
          A zone group is a named set of zones, all built from the same kind of administrative unit.
          If you want to change the unit, you'll need to create a new group.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit({ name: name.trim(), keyGroup });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5 mt-1">
            <label className="text-sm font-medium text-foreground">Unit type</label>
            <div className="flex flex-wrap gap-1.5">
              {KEY_GROUPS_AVAILABLE.map((kg) => {
                const selected = keyGroup === kg.value;
                return (
                  <button
                    type="button"
                    key={kg.value}
                    onClick={() => setKeyGroup(kg.value)}
                    disabled={pending}
                    className={
                      selected
                        ? "rounded-md border border-foreground bg-foreground/10 px-2.5 py-1 text-sm disabled:opacity-50"
                        : "rounded-md border border-border bg-background px-2.5 py-1 text-sm hover:border-muted-foreground disabled:opacity-50"
                    }
                  >
                    {kg.label}
                  </button>
                );
              })}
            </div>
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
        <DialogTitle>Duplicate group</DialogTitle>
        <DialogDescription>
          Creates a copy of the current group, including all zones. The new group uses the same unit
          type.
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

function DeleteDialog({
  open,
  onOpenChange,
  groupName,
  campaignCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  campaignCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = campaignCount > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete zone group?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{groupName}</span> because
              it is used by {campaignCount} campaign{campaignCount === 1 ? "" : "s"}. Detach or
              delete those campaigns first, then try again.
            </>
          ) : (
            <>
              Permanently deletes <span className="font-medium text-foreground">{groupName}</span>{" "}
              and every zone inside it. This can't be undone.
            </>
          )}
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          {inUse ? (
            <DialogClose render={<Button variant="outline" />}>Ok</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                Delete group
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClearDialog({
  open,
  onOpenChange,
  groupName,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Clear all zones?</DialogTitle>
        <DialogDescription>
          Deletes every zone in <span className="font-medium text-foreground">{groupName}</span>.
          The group itself is kept; you can start fresh with new zones. This can't be undone.
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            Clear all zones
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
