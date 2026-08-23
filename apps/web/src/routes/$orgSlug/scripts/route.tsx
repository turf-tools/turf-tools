import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Copy, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { notify } from "~/lib/notify";
import { Button } from "~/components/button";
import { DialogError } from "~/components/callout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { DeleteDialog, type DeleteBlocker } from "~/components/delete-dialog";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { Rail, useShowArchived } from "~/components/rail";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { settleMutation } from "~/lib/settle";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn, nextUntitledName } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/$orgSlug/scripts")({
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(scriptsListQuery()),
  component: ScriptsLayout,
});

function ScriptsLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { orgSlug } = Route.useParams();
  const params = useParams({ strict: false }) as { scriptId?: string };
  const activeScriptId = params.scriptId ?? null;
  const shouldFade = useFadeOnce("/scripts");

  const { data: scripts } = useSuspenseQuery(scriptsListQuery());
  const sortedScripts = sortByName(scripts);
  const activeScripts = sortedScripts.filter((s) => !s.isArchived);
  const archivedScripts = sortedScripts.filter((s) => s.isArchived);
  const [showArchived, setShowArchived] = useShowArchived(archivedScripts.length);
  const activeScript = scripts.find((s) => s.scriptId === activeScriptId) ?? null;

  const goToScript = (id: string) =>
    navigate({ to: "/$orgSlug/scripts/$scriptId", params: { orgSlug, scriptId: id } });

  const renameScript = useDialogMutation({
    mutationFn: (input: { scriptId: string; name: string }) => client.scripts.rename(input),
    onSuccess: (_data, input) =>
      settleMutation(queryClient, {
        keys: [["scripts"], ["script", input.scriptId]],
        patch: () => {
          queryClient.setQueryData<typeof scripts>(
            ["scripts"],
            (old) =>
              old?.map((s) => (s.scriptId === input.scriptId ? { ...s, name: input.name } : s)) ??
              old,
          );
          queryClient.setQueryData<{ name: string } & object>(["script", input.scriptId], (old) =>
            old ? { ...old, name: input.name } : old,
          );
        },
      }),
  });

  // New scripts are created immediately as "Untitled script" (no naming step).
  const createScript = useMutation({
    mutationFn: (input: { name: string }) => client.scripts.create(input),
    onSuccess: (created) =>
      settleMutation(queryClient, {
        keys: [["scripts"], ["script", created.scriptId]],
        // Inject and navigate in one synchronous block so React batches both
        // updates — otherwise the new row renders unselected for a frame.
        patch: () => {
          queryClient.setQueryData<typeof scripts>(["scripts"], (old) =>
            old ? [...old, created] : [created],
          );
          queryClient.setQueryData(["script", created.scriptId], { ...created, steps: [] });
          return goToScript(created.scriptId);
        },
      }),
  });

  const cloneScript = useDialogMutation({
    mutationFn: (input: { scriptId: string; newName: string }) => client.scripts.clone(input),
    onSuccess: (created) =>
      settleMutation(queryClient, {
        keys: [["scripts"], ["script", created.scriptId]],
        patch: () => {
          queryClient.setQueryData<typeof scripts>(["scripts"], (old) =>
            old ? [...old, created] : [created],
          );
          return goToScript(created.scriptId);
        },
      }),
  });

  const setScriptArchived = useMutation({
    mutationFn: (input: { scriptId: string; archived: boolean }) =>
      input.archived
        ? client.scripts.archive({ scriptId: input.scriptId })
        : client.scripts.unarchive({ scriptId: input.scriptId }),
    onSuccess: (_data, input) => {
      setArchiveOpen(false);
      return settleMutation(queryClient, {
        keys: [["scripts"]],
        patch: async () => {
          const patch = () =>
            queryClient.setQueryData<typeof scripts>(
              ["scripts"],
              (old) =>
                old?.map((s) =>
                  s.scriptId === input.scriptId ? { ...s, isArchived: input.archived } : s,
                ) ?? old,
            );
          if (input.archived) {
            // Leave before the cache says "archived" — a patched cache under
            // a still-selected item renders a one-frame "Unarchive" flash.
            // With a fallback, move first and patch after. On the last
            // active item the index redirect needs the patched list (else it
            // bounces back here), so patch and navigate in one synchronous
            // block — batched into a single render, like the create flows.
            const idx = activeScripts.findIndex((s) => s.scriptId === input.scriptId);
            const fallback = activeScripts[idx - 1] ?? activeScripts[idx + 1] ?? null;
            if (fallback) {
              await goToScript(fallback.scriptId);
              patch();
            } else {
              patch();
              await navigate({ to: "/$orgSlug/scripts", params: { orgSlug } });
            }
          } else {
            patch();
          }
        },
      });
    },
  });

  // Archive flow: archive checks for active campaigns first and confirms
  // through the dialog when any reference this script, then exits to a
  // neighboring active script (or the index when none remain).
  // Snapshotted at click time so the dialog body keeps its content
  // during the close animation.
  const [archiveSnapshot, setArchiveSnapshot] = useState({ name: "", campaignCount: 0 });
  const [archiveOpen, setArchiveOpen] = useState(false);

  const archiveActiveScript = async () => {
    if (!activeScript || activeScript.isArchived) return;
    const { count } = await queryClient.fetchQuery({
      queryKey: ["scripts", "count-campaigns", activeScript.scriptId],
      queryFn: () => client.scripts.countCampaigns({ scriptId: activeScript.scriptId }),
      staleTime: 0,
    });
    if (count > 0) {
      setArchiveSnapshot({ name: activeScript.name, campaignCount: count });
      setArchiveOpen(true);
    } else {
      setScriptArchived.mutate({ scriptId: activeScript.scriptId, archived: true });
    }
  };

  const onConfirmArchive = () => {
    if (!activeScriptId) return;
    setScriptArchived.mutate({ scriptId: activeScriptId, archived: true });
  };

  // Delete flow (archived scripts only): fetch what still references the
  // script, then confirm through the dialog — referenced scripts get an
  // explanation instead of a destructive action.
  const [removeSnapshot, setRemoveSnapshot] = useState<{
    name: string;
    blockers: DeleteBlocker[];
  }>({ name: "", blockers: [] });
  const [removeOpen, setRemoveOpen] = useState(false);

  const removeScript = useMutation({
    mutationFn: (input: { scriptId: string }) => client.scripts.remove(input),
    onSuccess: (_data, input) => {
      setRemoveOpen(false);
      return settleMutation(queryClient, {
        keys: [["scripts"]],
        evict: [["script", input.scriptId]],
        patch: async () => {
          // Exit to a neighbor in the visible rail (archived rows are shown
          // while one is selected), patch the row out, then let the redirect
          // land — same ordering rationale as the archive flow above.
          const visible = sortedScripts.filter((s) => s.scriptId !== input.scriptId);
          const idx = sortedScripts.findIndex((s) => s.scriptId === input.scriptId);
          const fallback = visible[idx - 1] ?? visible[idx] ?? null;
          const patch = () =>
            queryClient.setQueryData<typeof scripts>(
              ["scripts"],
              (old) => old?.filter((s) => s.scriptId !== input.scriptId) ?? old,
            );
          if (fallback) {
            await goToScript(fallback.scriptId);
            patch();
          } else {
            patch();
            await navigate({ to: "/$orgSlug/scripts", params: { orgSlug } });
          }
        },
      });
    },
  });

  const deleteActiveScript = async () => {
    if (!activeScript?.isArchived) return;
    try {
      const { blockers } = await client.scripts.removeCheck({ scriptId: activeScript.scriptId });
      setRemoveSnapshot({ name: activeScript.name, blockers });
      setRemoveOpen(true);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "Couldn't check references.");
    }
  };

  const onConfirmRemove = () => {
    if (!activeScriptId) return;
    removeScript.mutate({ scriptId: activeScriptId });
  };

  // Command-Delete escalates: archive an active script, delete an
  // archived one (behind the confirm). Command-U is the way back.
  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeScript,
    onMatch: () => void (activeScript?.isArchived ? deleteActiveScript() : archiveActiveScript()),
  });
  useHotkey({
    key: "u",
    mod: true,
    enabled: !!activeScript?.isArchived,
    onMatch: () => {
      if (activeScriptId) setScriptArchived.mutate({ scriptId: activeScriptId, archived: false });
    },
  });

  return (
    <>
      <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
        <Rail
          footer={
            archivedScripts.length > 0 ? (
              <Rail.ShowArchived
                show={showArchived}
                onToggle={(next) => {
                  setShowArchived(next);
                  // Hiding archived while one is selected would leave the
                  // editor on a row absent from the rail — exit to the index.
                  if (!next && activeScript?.isArchived)
                    void navigate({ to: "/$orgSlug/scripts", params: { orgSlug } });
                }}
              />
            ) : null
          }
        >
          {(showArchived ? sortedScripts : activeScripts).map((s) => (
            <Rail.Item
              key={s.scriptId}
              label={s.name}
              active={s.scriptId === activeScriptId}
              trailing={s.isArchived ? <Archive className="ml-2 size-4 shrink-0" /> : undefined}
              onSelect={() => void goToScript(s.scriptId)}
              onRename={renameScript.open}
            />
          ))}
          <Rail.New
            label="New script"
            disabled={createScript.isPending}
            onClick={() =>
              createScript.mutate({ name: nextUntitledName("Untitled script", scripts) })
            }
          />
        </Rail>

        <EditorPage>
          <EditorHeader title="Script Editor" subtitle={activeScript?.name}>
            <Button variant="outline" onClick={renameScript.open} disabled={!activeScript}>
              <Pencil />
              Rename
            </Button>
            <Button variant="outline" onClick={cloneScript.open} disabled={!activeScript}>
              <Copy />
              Clone
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                activeScript?.isArchived
                  ? setScriptArchived.mutate({ scriptId: activeScript.scriptId, archived: false })
                  : void archiveActiveScript()
              }
              disabled={!activeScript}
            >
              {activeScript?.isArchived ? <ArchiveRestore /> : <Archive />}
              {activeScript?.isArchived ? "Unarchive" : "Archive"}
            </Button>
            {activeScript?.isArchived ? (
              <Button variant="outline" onClick={() => void deleteActiveScript()}>
                <Trash2 />
                Delete
              </Button>
            ) : null}
          </EditorHeader>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </EditorPage>
      </div>

      <SaveAsDialog
        open={cloneScript.isOpen}
        onOpenChange={cloneScript.onOpenChange}
        defaultName={activeScript ? `${activeScript.name} (copy)` : ""}
        pending={cloneScript.isPending}
        error={cloneScript.error}
        onSubmit={(newName) => {
          if (!activeScriptId) return;
          cloneScript.mutate({ scriptId: activeScriptId, newName });
        }}
      />

      <RenameDialog
        open={renameScript.isOpen}
        onOpenChange={renameScript.onOpenChange}
        currentName={activeScript?.name ?? ""}
        pending={renameScript.isPending}
        error={renameScript.error}
        onSubmit={(name) => {
          if (!activeScriptId) return;
          if (name === activeScript?.name) {
            renameScript.close();
            return;
          }
          renameScript.mutate({ scriptId: activeScriptId, name });
        }}
      />

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={(next) => {
          if (setScriptArchived.isPending) return;
          setArchiveOpen(next);
        }}
        scriptName={archiveSnapshot.name}
        campaignCount={archiveSnapshot.campaignCount}
        pending={setScriptArchived.isPending}
        onConfirm={onConfirmArchive}
      />

      <DeleteDialog
        open={removeOpen}
        onOpenChange={(next) => {
          if (removeScript.isPending) return;
          setRemoveOpen(next);
        }}
        entity="script"
        name={removeSnapshot.name}
        blockers={removeSnapshot.blockers}
        pending={removeScript.isPending}
        onConfirm={onConfirmRemove}
      />
    </>
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
        <DialogTitle>Clone script</DialogTitle>
        <DialogDescription>
          Creates a copy of the current script, including its steps.
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
        <DialogTitle>Rename script</DialogTitle>
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

// Confirm gate shown only when active campaigns reference the script —
// an unreferenced script archives without ceremony.
function ArchiveDialog({
  open,
  onOpenChange,
  scriptName,
  campaignCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scriptName: string;
  campaignCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  useConfirmHotkey({ open, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Archive script?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{scriptName}</span> is used by{" "}
          <span className="font-bold text-foreground">{campaignCount}</span> active campaign
          {campaignCount === 1 ? "" : "s"}. The campaigns keep working but the script will be
          hidden. You can unarchive it anytime.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={onConfirm} loading={pending}>
            <Archive />
            Archive script
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
