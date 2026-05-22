import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, Pencil, Trash2 } from "lucide-react";
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
import { scriptsListQuery } from "~/lib/queries/scripts";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn } from "~/lib/utils";
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
  const activeScript = scripts.find((s) => s.scriptId === activeScriptId) ?? null;

  const goToScript = (id: string) =>
    navigate({ to: "/$orgSlug/scripts/$scriptId", params: { orgSlug, scriptId: id } });

  const renameScript = useDialogMutation({
    mutationFn: (input: { scriptId: string; name: string }) => client.scripts.rename(input),
    onSuccess: (_data, input) => {
      queryClient.setQueryData<typeof scripts>(
        ["scripts"],
        (old) =>
          old?.map((s) => (s.scriptId === input.scriptId ? { ...s, name: input.name } : s)) ?? old,
      );
      void queryClient.invalidateQueries({ queryKey: ["scripts"] });
    },
  });

  const createScript = useDialogMutation({
    mutationFn: (input: { name: string }) => client.scripts.create(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof scripts>(["scripts"], (old) =>
        old ? [...old, created] : [created],
      );
      queryClient.setQueryData(["script", created.scriptId], { ...created, steps: [] });
      void queryClient.invalidateQueries({ queryKey: ["scripts"] });
      return goToScript(created.scriptId);
    },
  });

  const cloneScript = useDialogMutation({
    mutationFn: (input: { scriptId: string; newName: string }) => client.scripts.clone(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof scripts>(["scripts"], (old) =>
        old ? [...old, created] : [created],
      );
      void queryClient.invalidateQueries({ queryKey: ["scripts"] });
      void queryClient.invalidateQueries({ queryKey: ["script", created.scriptId] });
      return goToScript(created.scriptId);
    },
  });

  const deleteScript = useDialogMutation({
    mutationFn: (scriptId: string) => client.scripts.remove({ scriptId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scripts"] });
    },
  });

  const [deleteSnapshot, setDeleteSnapshot] = useState({ name: "", campaignCount: 0 });

  const onConfirmDelete = () => {
    if (!activeScriptId) return;
    const idx = sortedScripts.findIndex((s) => s.scriptId === activeScriptId);
    const fallback = sortedScripts[idx - 1] ?? sortedScripts[idx + 1] ?? null;
    deleteScript.mutate(activeScriptId, {
      onSuccess: async () => {
        if (fallback) {
          await goToScript(fallback.scriptId);
        } else {
          await navigate({ to: "/$orgSlug/scripts", params: { orgSlug } });
        }
      },
    });
  };

  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeScriptId,
    onMatch: () => {
      if (!activeScriptId) return;
      void (async () => {
        const { count } = await queryClient.fetchQuery({
          queryKey: ["scripts", "count-campaigns", activeScriptId],
          queryFn: () => client.scripts.countCampaigns({ scriptId: activeScriptId }),
          staleTime: 0,
        });
        setDeleteSnapshot({ name: activeScript?.name ?? "", campaignCount: count });
        deleteScript.open();
      })();
    },
  });

  return (
    <>
      <div
        className={cn(
          "flex h-[calc(100vh-3.5rem)]",
          shouldFade && "animate-in fade-in duration-100",
        )}
      >
        <Rail>
          {sortedScripts.map((s) => (
            <Rail.Item
              key={s.scriptId}
              label={s.name}
              active={s.scriptId === activeScriptId}
              onSelect={() => void goToScript(s.scriptId)}
              onRename={renameScript.open}
            />
          ))}
          <Rail.New label="New script" onClick={createScript.open} />
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
              onClick={async () => {
                if (!activeScriptId) return;
                const { count } = await queryClient.fetchQuery({
                  queryKey: ["scripts", "count-campaigns", activeScriptId],
                  queryFn: () => client.scripts.countCampaigns({ scriptId: activeScriptId }),
                  staleTime: 0,
                });
                setDeleteSnapshot({ name: activeScript?.name ?? "", campaignCount: count });
                deleteScript.open();
              }}
              disabled={!activeScript}
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

      <CreateScriptDialog
        open={createScript.isOpen}
        onOpenChange={createScript.onOpenChange}
        pending={createScript.isPending}
        error={createScript.error}
        onSubmit={(name) => createScript.mutate({ name })}
      />

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

      <DeleteDialog
        open={deleteScript.isOpen}
        onOpenChange={deleteScript.onOpenChange}
        scriptName={deleteSnapshot.name}
        campaignCount={deleteSnapshot.campaignCount}
        pending={deleteScript.isPending}
        error={deleteScript.error}
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

function CreateScriptDialog({
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
        <DialogTitle>Create new script</DialogTitle>
        <DialogDescription>
          A script is an ordered sequence of questions and text for collecting responses.
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
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename script</DialogTitle>
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
  scriptName,
  campaignCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scriptName: string;
  campaignCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = campaignCount > 0;
  useConfirmHotkey({ open: open && !inUse, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{inUse ? "Can't delete script" : "Delete script?"}</DialogTitle>
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{scriptName}</span> because
              it is used by <span className="font-bold text-foreground">{campaignCount}</span>{" "}
              campaign
              {campaignCount === 1 ? "" : "s"}. Detach or delete those campaigns first, then try
              again.
            </>
          ) : (
            <>
              Permanently deletes <span className="font-medium text-foreground">{scriptName}</span>.
              This can't be undone.
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
                Delete script
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
