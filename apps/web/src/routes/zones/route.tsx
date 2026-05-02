import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, Eraser, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { Input } from "~/components/input";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { zoneGroupsQuery } from "~/lib/queries/zones";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByUpdatedAt<T extends { updatedAt: string | Date }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export const Route = createFileRoute("/zones")({
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(zoneGroupsQuery()),
  component: ZonesLayout,
});

function ZonesLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { zoneGroupId?: string };
  const activeGroupId = params.zoneGroupId ?? null;
  const shouldFade = useFadeOnce("/zones");

  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const sortedZoneGroups = sortByUpdatedAt(zoneGroups);
  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const goToGroup = (id: string) => {
    void navigate({ to: "/zones/$zoneGroupId", params: { zoneGroupId: id } });
  };

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zone-groups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
      // Inject before navigating so the loader sees the new group.
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      goToGroup(created.zoneGroupId);
    },
  });

  const cloneGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; newName: string }) => client.zoneGroups.clone(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      goToGroup(created.zoneGroupId);
    },
  });

  const clearZones = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zones.removeAllInGroup({ zoneGroupId }),
    onSuccess: (_data, zoneGroupId) => {
      void queryClient.invalidateQueries({ queryKey: ["zones", zoneGroupId] });
    },
  });

  const deleteGroup = useDialogMutation({
    mutationFn: (zoneGroupId: string) => client.zoneGroups.remove({ zoneGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
    },
  });

  // Snapshotted at click time so the dialog body keeps showing the
  // just-deleted name during its close animation, even after the URL
  // has reactively swapped to the fallback zone group.
  const [deleteSnapshot, setDeleteSnapshot] = useState({ name: "", campaignCount: 0 });

  const onConfirmDelete = () => {
    if (!activeGroupId) return;
    const idx = sortedZoneGroups.findIndex((g) => g.zoneGroupId === activeGroupId);
    // Previous neighbor; fall back to next if active is first; null if it
    // was the only group.
    const fallback = sortedZoneGroups[idx - 1] ?? sortedZoneGroups[idx + 1] ?? null;
    deleteGroup.mutate(activeGroupId, {
      onSuccess: () => {
        if (fallback) {
          goToGroup(fallback.zoneGroupId);
        } else {
          void navigate({ to: "/zones" });
        }
      },
    });
  };

  // Inline rename in the list column (dbl-click a row name).
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const inlineRenameGroup = useMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onMutate: ({ zoneGroupId, name }) => {
      void queryClient.cancelQueries({ queryKey: ["zone-groups"] });
      const previous = queryClient.getQueryData<typeof zoneGroups>(["zone-groups"]);
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old?.map((g) => (g.zoneGroupId === zoneGroupId ? { ...g, name } : g)),
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      console.error("zoneGroups.rename failed", e);
      if (ctx?.previous) queryClient.setQueryData(["zone-groups"], ctx.previous);
    },
  });

  const commitInlineRename = (groupId: string, currentName: string) => {
    const next = renameDraft.trim();
    setRenamingGroupId(null);
    if (next.length === 0 || next === currentName) return;
    inlineRenameGroup.mutate({ zoneGroupId: groupId, name: next });
  };

  return (
    <>
      <div
        className={cn(
          "-mx-8 -mt-5 -mb-8 flex h-[calc(100vh-3.5rem)]",
          shouldFade && "animate-in fade-in duration-100",
        )}
      >
        {/* Secondary sidebar — full-height compact list */}
        <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border">
          <div className="px-2 pt-5 pb-1">
            <button
              type="button"
              onClick={createGroup.open}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Plus className="size-3.5" />
              <span>New zone group</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pb-2">
            {sortedZoneGroups.map((g) => {
              const isActive = g.zoneGroupId === activeGroupId;
              const isRenaming = renamingGroupId === g.zoneGroupId;
              return (
                <div
                  key={g.zoneGroupId}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isRenaming) return;
                    if (!isActive) goToGroup(g.zoneGroupId);
                  }}
                  onKeyDown={(e) => {
                    if (isRenaming) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      goToGroup(g.zoneGroupId);
                    }
                  }}
                  className={cn(
                    "mx-2 my-0.5 flex cursor-pointer items-center rounded-md px-3 py-1.5 text-sm select-none",
                    isActive
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={renameDraft}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitInlineRename(g.zoneGroupId, g.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitInlineRename(g.zoneGroupId, g.name);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingGroupId(null);
                        }
                      }}
                      className="h-6 flex-1 px-2 text-sm"
                    />
                  ) : (
                    <span
                      className="flex-1 truncate"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenameDraft(g.name);
                        setRenamingGroupId(g.zoneGroupId);
                      }}
                    >
                      {g.name}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Editor column: h1 + actions + Outlet */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-8 pt-5 pb-8">
          <div className="mb-4 flex h-8 items-center justify-between">
            <h1 className="text-xl font-extrabold tracking-wide italic">Zone Editor</h1>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={renameGroup.open} disabled={!activeGroup}>
                <Pencil />
                Rename
              </Button>
              <Button variant="outline" onClick={cloneGroup.open} disabled={!activeGroup}>
                <Copy />
                Duplicate
              </Button>
              <Button variant="outline" onClick={clearZones.open} disabled={!activeGroup}>
                <Eraser />
                Clear
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  if (!activeGroupId) return;
                  const { count } = await queryClient.fetchQuery({
                    queryKey: ["zone-groups", "count-campaigns", activeGroupId],
                    queryFn: () => client.zoneGroups.countCampaigns({ zoneGroupId: activeGroupId }),
                    staleTime: 0,
                  });
                  setDeleteSnapshot({ name: activeGroup?.name ?? "", campaignCount: count });
                  deleteGroup.open();
                }}
                disabled={!activeGroup}
              >
                <Trash2 />
                Delete
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
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
        groupName={deleteSnapshot.name}
        campaignCount={deleteSnapshot.campaignCount}
        pending={deleteGroup.isPending}
        error={deleteGroup.error}
        onConfirm={onConfirmDelete}
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
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-sm disabled:opacity-50 active:translate-y-px",
                      selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
                    )}
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
