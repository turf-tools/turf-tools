import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Copy, Eraser, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/button";
import { DialogError } from "~/components/callout";
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
import { NoActiveDataset } from "~/components/no-active-dataset";
import { Rail, useShowArchived } from "~/components/rail";
import { useFilterCatalog } from "~/lib/manifest";
import { manifestQuery } from "~/lib/queries/manifest";
import { hasPermission } from "~/lib/permissions";
import { zoneGroupsQuery } from "~/lib/queries/zones";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/$orgSlug/zones")({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.fetchQuery(zoneGroupsQuery()),
      queryClient.fetchQuery(manifestQuery()),
    ]),
  component: ZonesLayout,
});

function ZonesLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { orgSlug } = Route.useParams();
  const params = useParams({ strict: false }) as { zoneGroupId?: string };
  const activeGroupId = params.zoneGroupId ?? null;
  const shouldFade = useFadeOnce("/zones");

  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const { data: manifest } = useSuspenseQuery(manifestQuery());
  const { role } = Route.useRouteContext();
  const sortedZoneGroups = sortByName(zoneGroups);
  const activeZoneGroups = sortedZoneGroups.filter((g) => !g.isArchived);
  const archivedZoneGroups = sortedZoneGroups.filter((g) => g.isArchived);
  const [showArchived, setShowArchived] = useShowArchived(archivedZoneGroups.length);
  const activeGroup = zoneGroups.find((g) => g.zoneGroupId === activeGroupId) ?? null;

  const goToGroup = (id: string) =>
    navigate({ to: "/$orgSlug/zones/$zoneGroupId", params: { orgSlug, zoneGroupId: id } });

  const renameGroup = useDialogMutation({
    mutationFn: (input: { zoneGroupId: string; name: string }) => client.zoneGroups.rename(input),
    onSuccess: (_data, input) => {
      queryClient.setQueryData<typeof zoneGroups>(
        ["zone-groups"],
        (old) =>
          old?.map((g) => (g.zoneGroupId === input.zoneGroupId ? { ...g, name: input.name } : g)) ??
          old,
      );
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
    },
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

  const setGroupArchived = useMutation({
    mutationFn: (input: { zoneGroupId: string; archived: boolean }) =>
      input.archived
        ? client.zoneGroups.archive({ zoneGroupId: input.zoneGroupId })
        : client.zoneGroups.unarchive({ zoneGroupId: input.zoneGroupId }),
    onSuccess: async (_data, input) => {
      // Cancel in-flight list fetches so a pre-mutation response can't
      // land after the patch and clobber it.
      await queryClient.cancelQueries({ queryKey: ["zone-groups"] });
      const patch = () =>
        queryClient.setQueryData<typeof zoneGroups>(
          ["zone-groups"],
          (old) =>
            old?.map((g) =>
              g.zoneGroupId === input.zoneGroupId ? { ...g, isArchived: input.archived } : g,
            ) ?? old,
        );
      if (input.archived) {
        // Leave before the cache says "archived" — a patched cache under
        // a still-selected item renders a one-frame "Unarchive" flash.
        // With a fallback, move first and patch after. On the last
        // active item the index redirect needs the patched list (else it
        // bounces back here), so patch and navigate in one synchronous
        // block — batched into a single render, like the create flows.
        setArchiveOpen(false);
        const idx = activeZoneGroups.findIndex((g) => g.zoneGroupId === input.zoneGroupId);
        const fallback = activeZoneGroups[idx - 1] ?? activeZoneGroups[idx + 1] ?? null;
        if (fallback) {
          await goToGroup(fallback.zoneGroupId);
          patch();
        } else {
          patch();
          await navigate({ to: "/$orgSlug/zones", params: { orgSlug } });
        }
      } else {
        patch();
      }
      void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
    },
    onError: (e) => toast.error(e.message),
  });

  // Archive flow: unarchive is immediate (and stays put); archive checks
  // for active campaigns first and confirms through the dialog when any
  // reference this group, then exits to a neighboring active group (or
  // the index when none remain). Snapshotted at click time so the
  // dialog body keeps its content during the close animation.
  const [archiveSnapshot, setArchiveSnapshot] = useState({ name: "", campaignCount: 0 });
  const [archiveOpen, setArchiveOpen] = useState(false);

  const archiveActiveGroup = async () => {
    if (!activeGroup) return;
    if (activeGroup.isArchived) {
      setGroupArchived.mutate({ zoneGroupId: activeGroup.zoneGroupId, archived: false });
      return;
    }
    const { count } = await queryClient.fetchQuery({
      queryKey: ["zone-groups", "count-campaigns", activeGroup.zoneGroupId],
      queryFn: () => client.zoneGroups.countCampaigns({ zoneGroupId: activeGroup.zoneGroupId }),
      staleTime: 0,
    });
    if (count > 0) {
      setArchiveSnapshot({ name: activeGroup.name, campaignCount: count });
      setArchiveOpen(true);
    } else {
      setGroupArchived.mutate({ zoneGroupId: activeGroup.zoneGroupId, archived: true });
    }
  };

  const onConfirmArchive = () => {
    if (!activeGroupId) return;
    setGroupArchived.mutate({ zoneGroupId: activeGroupId, archived: true });
  };

  // Mod-Delete / Mod-Backspace escalates from "delete one zone" (the inner
  // editor's plain-Delete handler) to "archive the whole zone group".
  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeGroupId,
    onMatch: () => void archiveActiveGroup(),
  });

  // No active dataset → nothing to build against; block the editor behind a
  // modal pointing to Data (dismiss returns to Overview).
  if (!manifest) {
    return (
      <NoActiveDataset
        entity="zones"
        orgSlug={orgSlug}
        canManage={hasPermission(role, "datasets.manage")}
      />
    );
  }

  return (
    <>
      <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
        <Rail
          footer={
            archivedZoneGroups.length > 0 ? (
              <Rail.ShowArchived
                show={showArchived}
                onToggle={(next) => {
                  setShowArchived(next);
                  // Hiding archived while one is selected would leave the
                  // editor on a row absent from the rail — exit to the index.
                  if (!next && activeGroup?.isArchived)
                    void navigate({ to: "/$orgSlug/zones", params: { orgSlug } });
                }}
              />
            ) : null
          }
        >
          {(showArchived ? sortedZoneGroups : activeZoneGroups).map((g) => (
            <Rail.Item
              key={g.zoneGroupId}
              label={g.name}
              active={g.zoneGroupId === activeGroupId}
              trailing={g.isArchived ? <Archive className="ml-2 size-4 shrink-0" /> : undefined}
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
              Clone
            </Button>
            <Button variant="outline" onClick={clearZones.open} disabled={!activeGroup}>
              <Eraser />
              Clear
            </Button>
            <Button
              variant="outline"
              onClick={() => void archiveActiveGroup()}
              disabled={!activeGroup}
            >
              {activeGroup?.isArchived ? <ArchiveRestore /> : <Archive />}
              {activeGroup?.isArchived ? "Unarchive" : "Archive"}
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

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={(next) => {
          if (setGroupArchived.isPending) return;
          setArchiveOpen(next);
        }}
        groupName={archiveSnapshot.name}
        campaignCount={archiveSnapshot.campaignCount}
        pending={setGroupArchived.isPending}
        onConfirm={onConfirmArchive}
      />
    </>
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

  const trimmed = name.trim();
  const dirty = trimmed !== currentName;
  const valid = trimmed.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename group</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !dirty || pending) return;
            onSubmit(trimmed);
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
            <Button type="submit" disabled={!valid || !dirty} loading={pending}>
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
  const { keyGroups } = useFilterCatalog();
  const [name, setName] = useState("");
  const [keyGroup, setKeyGroup] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setKeyGroup(keyGroups[0]?.value ?? "");
    }
  }, [open, keyGroups]);

  const valid = name.trim().length > 0 && keyGroup.length > 0;

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
              {keyGroups.map((kg) => {
                const selected = keyGroup === kg.value;
                return (
                  <button
                    type="button"
                    key={kg.value}
                    onClick={() => setKeyGroup(kg.value)}
                    disabled={pending}
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
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
        <DialogTitle>Clone group</DialogTitle>
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
              Clone
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Confirm gate shown only when active campaigns reference the group —
// an unreferenced group archives without ceremony.
function ArchiveDialog({
  open,
  onOpenChange,
  groupName,
  campaignCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  campaignCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  useConfirmHotkey({ open, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Archive zone group?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{groupName}</span> is used by{" "}
          <span className="font-bold text-foreground">{campaignCount}</span> active campaign
          {campaignCount === 1 ? "" : "s"}. The campaigns keep working but the zone group will be
          hidden. You can unarchive it anytime.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={onConfirm} loading={pending}>
            <Archive />
            Archive group
          </Button>
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
