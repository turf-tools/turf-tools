import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, Eraser, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { Rail } from "~/components/rail";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { zoneGroupsQuery } from "~/lib/queries/zones";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
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
  const sortedZoneGroups = sortByName(zoneGroups);
  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const goToGroup = (id: string) =>
    navigate({ to: "/zones/$zoneGroupId", params: { zoneGroupId: id } });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["zone-groups"] }),
  });

  const createGroup = useDialogMutation({
    mutationFn: (input: { name: string; keyGroup: string }) => client.zoneGroups.create(input),
    onSuccess: (created) => {
      // Inject and navigate synchronously (no await between) so React
      // batches both updates into one render — otherwise the new row
      // appears in the list for a frame as unselected before the URL
      // catches up. Loader sees the cache injection because it runs in
      // the same microtask wave.
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      return goToGroup(created.zoneGroupId);
    },
  });

  const cloneGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; newName: string }) => client.zoneGroups.clone(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof zoneGroups>(["zone-groups"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      return goToGroup(created.zoneGroupId);
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
      onSuccess: async () => {
        if (fallback) {
          await goToGroup(fallback.zoneGroupId);
        } else {
          await navigate({ to: "/zones" });
        }
      },
    });
  };

  return (
    <>
      <div
        className={cn(
          "flex h-[calc(100vh-3.5rem)]",
          shouldFade && "animate-in fade-in duration-100",
        )}
      >
        <Rail>
          {sortedZoneGroups.map((g) => (
            <Rail.Item
              key={g.zoneGroupId}
              label={g.name}
              active={g.zoneGroupId === activeGroupId}
              onSelect={() => void goToGroup(g.zoneGroupId)}
              onRename={renameGroup.open}
            />
          ))}
          <Rail.New label="New zone group" onClick={createGroup.open} />
        </Rail>

        <EditorPage>
          <EditorHeader title="Zone Editor" subtitle={activeGroup?.name}>
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
          </EditorHeader>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </EditorPage>
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
